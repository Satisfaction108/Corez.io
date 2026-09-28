// TUTORIAL SESSION
//
// Runtime state for the tutorial server: which learner owns which plot, and the
// scripted bots each plot spawns on demand.
//
// Plot geometry and isolation: terrain/tutorialPlots.js.

const plots = require('./terrain/tutorialPlots.js');

// socket -> plot index, and the reverse occupancy table.
const owners = new Array(plots.plotCount()).fill(null);

// Per-plot scripted bots: { dummy, fighter, boss, chest } (Entity|null each)
const bots = new Array(plots.plotCount()).fill(null).map(() => ({ dummy: null, fighter: null, boss: null, chest: null }));

function plotOf(socket) {
    return socket && socket._tutorialPlot != null ? socket._tutorialPlot : -1;
}

// Claim the first free plot, or -1 when full (the caller rejects the join).
function claimPlot(socket) {
    const existing = plotOf(socket);
    if (existing >= 0) return existing;
    for (let i = 0; i < owners.length; i++) {
        if (owners[i] === null) {
            owners[i] = socket;
            socket._tutorialPlot = i;
            resetBase(i);
            return i;
        }
    }
    return -1;
}

function releasePlot(socket) {
    const i = plotOf(socket);
    if (i < 0) return;
    owners[i] = null;
    socket._tutorialPlot = null;
    clearBots(i);
    resetBase(i);
}

// The practice base starts neutral and LOCKED (shots bounce off) until the base
// lesson opens it. Reset on claim and release so no learner inherits a base.
function resetBase(plotIndex) {
    try { require('./terrain/outposts.js').resetSite(plotIndex, true); } catch (e) { }
}
function openBase(plotIndex) {
    try { require('./terrain/outposts.js').lockSite(plotIndex, false); } catch (e) { }
}

// Learners are TEAM_BLUE internally (vault and base rules key off it) but wear
// a Dig Royale palette colour. Red (12) is excluded: practice bots are red.
function learnerColor(socket) {
    if (socket && socket._tutColor != null) return socket._tutColor;
    const pal = (global.ROYALE_PALETTE || [10]).filter(c => c !== 12);
    const c = pal[Math.floor(Math.random() * pal.length)];
    if (socket) socket._tutColor = c;
    return c;
}

function freePlots() {
    return owners.reduce((n, o) => n + (o === null ? 1 : 0), 0);
}

function spawnPointFor(socket) {
    const i = plotOf(socket);
    if (i < 0) return null;
    return plots.plotPoint(i, 'spawn');
}

// The learner's arena, sent in the TUTI packet; the client cannot derive how
// the room is divided. Outposts and rocks are room-wide on the client, so every
// client world lookup is filtered through `arena` and these landmarks.
function plotInfo(index) {
    const pt = (k) => {
        const p = plots.plotPoint(index, k);
        return { x: Math.round(p.x), y: Math.round(p.y) };
    };
    const c = plots.plotCenter(index);
    const r = plots.plotRect(index);
    return {
        plot: index,
        spawn: pt('spawn'),
        clearing: pt('clearing'),
        rocks: pt('rocks'),
        vault: pt('vault'),
        outpost: pt('outpost'),        // the practice base
        shop: pt('shop'),
        chest: pt('chest'),
        boss: pt('boss'),
        // island the floor is painted on (and the fence)
        island: { x: Math.round(c.x), y: Math.round(c.y), r: plots.ISLAND_R },
        clearingR: plots.CLEARING.r,
        // full-map frame and the world-lookup filter
        cx: Math.round(c.x), cy: Math.round(c.y),
        size: plots.PLOT_SIZE,
        arena: {
            x0: Math.round(r.x0), y0: Math.round(r.y0),
            x1: Math.round(r.x1), y1: Math.round(r.y1),
        },
    };
}

function talkPlotInfo(socket) {
    const i = plotOf(socket);
    if (i < 0) return;
    try { socket.talk("TUTI", JSON.stringify(plotInfo(i))); } catch (e) { }
}

// ─── scripted bots ────────────────────────────────────────────────────────

function killBot(entity) {
    if (entity && !entity.isDead()) {
        entity.kill();
        entity.destroy();
    }
}

function clearBots(plotIndex) {
    const slot = bots[plotIndex];
    if (!slot) return;
    killBot(slot.dummy);
    killBot(slot.fighter);
    killBot(slot.boss);
    killBot(slot.chest);
    slot.dummy = slot.fighter = slot.boss = slot.chest = null;
}

// ─── Dig Royale chapter ───────────────────────────────────────────────────

// A loot chest beside the learner. Always carries a Medkit for the kit lesson.
function spawnChest(plotIndex) {
  try {
    const slot = bots[plotIndex];
    if (!slot) return null;
    if (slot.chest && !slot.chest.isDead() && !slot.chest._opened) return slot.chest;
    const chests = require('./terrain/chests.js');
    const at = besidePlayer(plotIndex, 340, -170);
    const o = chests.spawnChest(at.x, at.y, false, { gems: 120, item: 'medkit' });
    if (o) { o.isTutorialBot = true; plots.keepInPlot(o, plotIndex); }
    slot.chest = o;
    return o;
  } catch (e) { util.warn("tutorial: chest spawn failed - " + (e && e.message)); return null; }
}

// A training copy of a raid boss: real class and guns, a fraction of the health,
// damage scaled down (tutorialChipDamage). Erupts gems on death like the live one.
const BOSS_HEALTH_FRAC = 0.10;
function spawnBoss(plotIndex, kindId) {
  try {
    const slot = bots[plotIndex];
    if (!slot) return null;
    if (slot.boss && !slot.boss.isDead()) return slot.boss;
    const bosses = require('./terrain/bosses.js');
    const id = bosses.KINDS[kindId] ? kindId : 'warden';
    const kind = bosses.KINDS[id];
    const at = besidePlayer(plotIndex, 430, 0);
    const o = new Entity(at);
    o.define(kind.cls);
    o.team = TEAM_RED;
    o.name = kind.name;
    o.isRoyaleBoss = true;
    o.isTutorialBot = true;
    o.isBot = false;
    o.bossKind = id;
    o.bossContact = !!kind.contact;
    o.bossDigs = false;                       // the training ground keeps its wall
    o.bossHome = { x: at.x, y: at.y, r: 240 }; // roam here, not toward a storm
    o.alwaysActive = true;
    o.settings.leaderboardable = false;
    o.HEALTH *= BOSS_HEALTH_FRAC;
    o.SHIELD *= BOSS_HEALTH_FRAC;
    o.tutorialChipDamage = 0.22;
    o.refreshBodyAttributes();
    o.health.amount = o.health.max;
    if (o.shield) o.shield.amount = o.shield.max;
    try { global.gameManager.terrainGrid.pushCircleFromVoronoi(o, o.realSize || 60); } catch (e) { }
    o.on('dead', () => { try { bosses.erupt(o.x, o.y, 900); } catch (e) { } });
    slot.boss = o;
    return o;
  } catch (e) { util.warn("tutorial: boss spawn failed - " + (e && e.message)); return null; }
}

function clearBoss(plotIndex) {
    const slot = bots[plotIndex];
    if (!slot) return;
    killBot(slot.boss);
    slot.boss = null;
}

// Banked gems for the shop lesson (the shop spends only banked gems).
function setBanked(body, n) {
    if (!body) return;
    const gems = require('./terrain/gems.js');
    gems.setBanked(body, Math.max(0, n | 0));
    gems.talkGems(body, 0);
}

// Kit, gear and sidearm hand-outs, so lessons can show items before any purchase.
function grantKit(socket, id) {
    const shop = require('./terrain/shop.js');
    return shop.grantKit(socket, String(id || 'medkit'));
}
function grantGear(socket, id) {
    const shop = require('./terrain/shop.js');
    const body = socket && socket.player && socket.player.body;
    const item = shop.BY_ID.get(String(id || 'boots'));
    if (!body || !item || item.cat !== 'gear') return false;
    const s = shop.stateOf(socket);
    if (!s) return false;
    s.gear[item.id] = Date.now() + 300_000;
    shop.applyPassives(body);
    shop.talkState(socket, item.name + " is running for the next 5 minutes. " + (item.on || ""), true);
    return true;
}
function grantArm(socket, id) {
    const shop = require('./terrain/shop.js');
    const body = socket && socket.player && socket.player.body;
    const item = shop.BY_ID.get(String(id || 'flak'));
    if (!body || !item || item.cat !== 'arm') return false;
    const s = shop.stateOf(socket);
    if (!s) return false;
    s.arm = item.id;
    shop.attachSidearm(body, item.id);
    shop.talkState(socket, item.name + " mounted. Fire it with the sidearm key.", true);
    return true;
}

// Shared setup for practice targets: real enemy-team tanks, so damage, health
// bars, death and gem drops behave as in a real match.
function baseTarget(loc, name, opts = {}) {
    const o = new Entity(loc);
    o.define(Config.spawn_class);
    o.refreshBodyAttributes();
    o.team = TEAM_RED;
    o.color.base = getTeamColor(TEAM_RED);
    o.leaderboardColor = o.color.base;
    o.minimapColor = o.color.base;
    o.name = name;
    o.isBot = true;
    o.isTutorialBot = true;
    o.settings.leaderboardable = false;
    o.alwaysActive = true;

    const cap = opts.level != null ? opts.level : Config.level_cap_cheat;
    o.skill.reset();
    while (o.skill.level < cap) {
        o.skill.score += o.skill.levelScore;
        o.skill.maintain();
    }
    o.refreshBodyAttributes();

    if (Config.dig_wars) require('./terrain/gems.js').initSatchel(o);
    return o;
}

// On the island and out of solid rock (a tank dropped in rock wedges there).
function spawnClear(plotIndex, x, y) {
    if (!plots.onIsland(plotIndex, x, y, 200)) return false;

    const grid = global.gameManager && global.gameManager.terrainGrid;
    if (grid && grid.nearestRock) {
        const rock = grid.nearestRock(x, y, 150);
        if (rock && rock.alive) return false;
    }
    return true;
}

// A spot just off the learner's shoulder, so targets spawn on screen. The
// offset is a preference: it is tried first, then swept around the learner
// until a reachable spot is found (else the plot's dummy point).
function besidePlayer(plotIndex, dx, dy) {
    const socket = owners[plotIndex];
    const body = socket && socket.player && socket.player.body;
    const home = plots.plotPoint(plotIndex, 'dummy');
    if (!body || body.isDead()) return home;

    const want = Math.atan2(dy, dx);
    const dist = Math.hypot(dx, dy);
    // sweep outward from the requested bearing
    for (const spread of [0, 0.5, -0.5, 1, -1, 1.6, -1.6, 2.3, -2.3, Math.PI]) {
        for (const scale of [1, 0.75, 1.3]) {
            const a = want + spread;
            const x = body.x + Math.cos(a) * dist * scale;
            const y = body.y + Math.sin(a) * dist * scale;
            if (spawnClear(plotIndex, x, y)) return { x, y };
        }
    }
    return home;
}

// Full health and shield, e.g. before a fight after a lesson that drained health.
function heal(body) {
    if (!body) return;
    if (body.health && body.health.max) body.health.amount = body.health.max;
    if (body.shield && body.shield.max) body.shield.amount = body.shield.max;
}

// A target that never moves or shoots, for the first kill.
function spawnDummy(plotIndex) {
  try {
    const slot = bots[plotIndex];
    if (!slot) return null;
    if (slot.dummy && !slot.dummy.isDead()) return slot.dummy;

    const o = baseTarget(besidePlayer(plotIndex, 400, -110), 'Practice Dummy');
    o.controllers = [];               // no AI at all
    o.define({ CONTROLLERS: [] }, false, false, false);
    o.settings.hasNoRecoil = true;
    slot.dummy = o;
    return o;
  } catch (e) { util.warn("tutorial: dummy spawn failed - " + (e && e.message)); return null; }
}

// The first opponent that shoots back: a Basic on a thin stat spread (display
// order) that chips the health bar rather than emptying it.
const FIGHTER_STATS = [0, 0, 3, 1, 0, 1, 4, 3, 0, 0];

function spawnFighter(plotIndex) {
  try {
    const slot = bots[plotIndex];
    if (!slot) return null;
    if (slot.fighter && !slot.fighter.isDead()) return slot.fighter;

    const o = baseTarget(besidePlayer(plotIndex, 420, 130), 'Rookie');
    // Stays a Basic; baseTarget levelled it so it is real-opponent size.
    o.define({ CONTROLLERS: ["tutorialDuelist"] }, false, false, false);
    o.tutorialFoe = (owners[plotIndex] && owners[plotIndex].player)
        ? owners[plotIndex].player.body : null;
    o.botStatsFixed = true;
    o.botRespawnsRemaining = 0;
    setStats(o, FIGHTER_STATS);
    o.refreshBodyAttributes();
    // Outgoing shot and ram damage multiplier.
    o.tutorialChipDamage = 0.12;
    slot.fighter = o;
    return o;
  } catch (e) { util.warn("tutorial: fighter spawn failed - " + (e && e.message)); return null; }
}

// ─── staging helpers the lesson script drives ─────────────────────────────

// The skill bar the player sees is ordered
//   body damage, max health, bullet speed, bullet health, bullet penetration,
//   bullet damage, reload, movement speed, shield regen, shield capacity
// while Skill.raw is ordered [rld, pen, str, dam, spd, shi, atk, hlt, rgn, mob].
// Lessons use display order.
const DISPLAY_TO_RAW = [6, 7, 4, 2, 1, 3, 0, 9, 8, 5];

function setStats(body, list) {
    if (!body || !body.skill) return;
    const raw = body.skill.raw.slice();
    for (let i = 0; i < DISPLAY_TO_RAW.length && i < list.length; i++) {
        const v = Math.max(0, Math.min(Config.skill_cap, list[i] | 0));
        raw[DISPLAY_TO_RAW[i]] = v;
    }
    // eleventh value: Mining Power, raw index 10, same slot both ways
    if (list.length > 10 && raw.length > 10) raw[10] = Math.max(0, Math.min(Config.skill_cap, list[10] | 0));
    // set() clamps to caps; the overflow is refunded into points.
    const spent = raw.reduce((a, b) => a + b, 0);
    const before = body.skill.raw.reduce((a, b) => a + b, 0);
    body.skill.set(raw);
    body.skill.points = Math.max(0, body.skill.points + before - spent);
    body.refreshBodyAttributes();
}

// Ensure at least n unspent points (e.g. a morph opens a new stat after all were spent).
function grantPoints(body, n) {
    if (!body || !body.skill) return;
    body.skill.points = Math.max(body.skill.points, n | 0);
}

// Every stat to its cap except `exceptDisplay`, left empty with `spare` points
// in hand. Caps come from the skill object so class retunes do not drift.
function fillStats(body, exceptDisplay, spare) {
    if (!body || !body.skill) return;
    const raw = body.skill.raw.slice();
    for (let d = 0; d < DISPLAY_TO_RAW.length; d++) {
        const r = DISPLAY_TO_RAW[d];
        raw[r] = d === exceptDisplay ? 0 : body.skill.caps[r];
    }
    body.skill.set(raw);
    body.skill.points = Math.max(0, spare | 0);
    body.refreshBodyAttributes();
}

// Spend all unspent points on an all-round build, so later lessons are not
// played half-built. Round-robin over a priority list of Skill.raw indices,
// respecting caps (stats a class cannot use are skipped).
//   raw: [rld, pen, str, dam, spd, shi, atk, hlt, rgn, mob, mine]
const REST_PRIORITY = [10, 3, 0, 1, 2, 7, 4, 9, 5, 8, 6];
function spendRest(body) {
    if (!body || !body.skill) return;
    const sk = body.skill;
    let guard = 400;
    while (sk.points > 0 && guard-- > 0) {
        let spent = false;
        for (const r of REST_PRIORITY) {
            if (sk.points <= 0) break;
            if (r >= sk.raw.length) continue;
            if (sk.raw[r] < sk.caps[r]) { sk.raw[r]++; sk.points--; spent = true; }
        }
        if (!spent) break;
    }
    sk.update();
    body.refreshBodyAttributes();
}

// Move the learner to the lesson's landmark. Glided (tickGlide) rather than
// snapped: an instant jump looks like a disconnect and the client camera lerps
// into a lurch.
const GLIDE_MS = 420;

function teleport(socket, key) {
    const i = plotOf(socket);
    const body = socket && socket.player && socket.player.body;
    if (i < 0 || !body || body.isDead()) return;
    const layoutKey = key;
    let p;
    try { p = plots.plotPoint(i, layoutKey); } catch (e) { return; }
    // Land beside the base, not inside it (a tank on a chamber ring wedges).
    // Pads are meant to be stood on, so get no offset.
    const off = layoutKey === "outpost" ? -260 : 0;
    teleportTo(socket, p.x + off, p.y);
}

// Glide to a world point, clamped to this learner's fence (e.g. beside the
// rock the client marked).
function teleportTo(socket, x, y) {
    const i = plotOf(socket);
    const body = socket && socket.player && socket.player.body;
    if (i < 0 || !body || body.isDead()) return;
    x = +x; y = +y;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const f = plots.plotFence(i);
    const dx = x - f.cx, dy = y - f.cy, d = Math.hypot(dx, dy), lim = f.r - 150;
    if (d > lim) { x = f.cx + dx * (lim / d); y = f.cy + dy * (lim / d); }
    // Land on open ground, or the physics pass's entombed-tank rescue would
    // push it out a moment later (a second jump).
    const open = openGround(i, x, y, (body.realSize || 60) + 10);
    x = open.x; y = open.y;
    if (Math.hypot(body.x - x, body.y - y) < 120) return;
    body._tutorialGlide = {
        fromX: body.x, fromY: body.y,
        toX: x, toY: y,
        at: Date.now(),
    };
}

function openGround(plotIndex, x, y, r) {
    const grid = global.gameManager && global.gameManager.terrainGrid;
    if (!grid || !grid.pointInRock) return { x, y };
    const clear = (px, py) => {
        if (!plots.onIsland(plotIndex, px, py, 150)) return false;
        if (grid.pointInRock(px, py)) return false;
        for (let k = 0; k < 8; k++) {
            const a = k * Math.PI / 4;
            if (grid.pointInRock(px + Math.cos(a) * r, py + Math.sin(a) * r)) return false;
        }
        return true;
    };
    if (clear(x, y)) return { x, y };
    for (let ring = 1; ring <= 10; ring++) {
        for (let k = 0; k < 12; k++) {
            const a = k / 12 * Math.PI * 2 + ring * 0.4;
            const px = x + Math.cos(a) * ring * 50, py = y + Math.sin(a) * ring * 50;
            if (clear(px, py)) return { x: px, y: py };
        }
    }
    return { x, y };
}

function tickGlide() {
    const now = Date.now();
    for (const socket of owners) {
        const body = socket && socket.player && socket.player.body;
        const g = body && body._tutorialGlide;
        if (!g) continue;
        if (body.isDead()) { body._tutorialGlide = null; continue; }
        let t = (now - g.at) / GLIDE_MS;
        if (t >= 1) {
            t = 1;
            body._tutorialGlide = null;
        }
        // smoothstep
        const e = t * t * (3 - 2 * t);
        body.x = g.fromX + (g.toX - g.fromX) * e;
        body.y = g.fromY + (g.toY - g.fromY) * e;
        if (body.velocity) { body.velocity.x = 0; body.velocity.y = 0; }
        if (body.accel) { body.accel.x = 0; body.accel.y = 0; }
    }
}

// Force an allowlisted player command flag (e.g. auto-fire off).
function setCommand(socket, name, on) {
    const p = socket && socket.player;
    if (!p || !p.command) return;
    if (!['autofire', 'autospin', 'override', 'autoalt', 'spinlock'].includes(name)) return;
    p.command[name] = !!on;
}

// ─── step gating ──────────────────────────────────────────────────────────
//
// Each step declares what it permits; everything else is refused at the socket
// (not just hidden in the UI, since keyboard shortcuts bypass it). This keeps
// learners from reaching states the script cannot recover from. Movement and
// firing are never gated.
const CAPS = ['stats', 'upgrade', 'bank', 'shop', 'kit'];

// Permissions live on the SOCKET, not the body, so they survive a respawn.
function gateOf(body) {
    if (!body) return null;
    return body.socket || body;
}

// csv items:
//   "stats"              every stat bar
//   "stats:2.3.4.5.6"    only these bars (skill-bar / x-packet indices)
//   "budget:3"           at most this many stat points this step
//   "bank:vault"         deposit at a vault only ("bank:base" = own base only)
//   "shop:drill"         buy from these shop categories only
//   "kit:medkit"         fire only these kit items (no arg = any, and drops)
//   "upgrade"            evolve
// The whole set is replaced on every step, so no lock outlives its lesson.
function setAllowed(body, csv) {
    const g = gateOf(body);
    if (!g) return;
    const list = String(csv || '').split(',').map(x => x.trim()).filter(Boolean);
    const caps = new Map();
    let budget = Infinity;
    for (const item of list) {
        const [cap, arg] = item.split(':');
        if (cap === 'budget') {
            const n = parseInt(arg, 10);
            if (n >= 0) budget = n;
            continue;
        }
        if (!CAPS.includes(cap)) continue;
        const args = arg === undefined ? null
            : new Set(String(arg).split('.').map(x => x.trim()).filter(Boolean));
        caps.set(cap, args);
    }
    g._tutorialAllow = caps;
    g._tutStatBudget = budget;
}

// Default-closed: no declaration means nothing is allowed. `arg` narrows the
// check ("vault", "drill", "medkit"); a cap declared without a list allows any arg.
function allows(body, cap, arg) {
    if (!Config.tutorial) return true;
    const g = gateOf(body);
    if (!g || !g._tutorialAllow) return false;
    if (!g._tutorialAllow.has(cap)) return false;
    const args = g._tutorialAllow.get(cap);
    if (!args || arg === undefined) return true;
    return args.has(String(arg));
}

// A cap declared with NO arg list. Kit drops require it, so dropping an item
// cannot pass for using it.
function allowsAll(body, cap) {
    if (!Config.tutorial) return true;
    const g = gateOf(body);
    return !!(g && g._tutorialAllow && g._tutorialAllow.has(cap) && !g._tutorialAllow.get(cap));
}

// The bar must be one the step teaches and the step's budget not yet spent.
function allowsStat(body, index) {
    if (!Config.tutorial) return true;
    if (!allows(body, 'stats', index)) return false;
    const g = gateOf(body);
    return !(g._tutStatBudget <= 0);
}

// Called after every point the learner actually placed.
function noteStatSpent(body) {
    const g = gateOf(body);
    if (g && Number.isFinite(g._tutStatBudget)) g._tutStatBudget = Math.max(0, g._tutStatBudget - 1);
}

// ─── forced upgrade path ──────────────────────────────────────────────────
//
// The class menu can be filtered down to the tank a lesson is about.

const normalise = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// The lock takes a comma-separated PATH, not a single tank: a target several
// tiers up (Twin, Triple Shot, Penta Shot) would otherwise leave tier one's menu
// empty. Naming every rung offers exactly one choice per tier.
function lockUpgrades(body, path) {
    const names = String(path || '').split(',').map(normalise).filter(Boolean);
    body._tutorialLock = names.length ? names : null;
}

function unlockUpgrades(body) {
    body._tutorialLock = null;
}

// Consulted by sockets.js while it builds the offered-upgrade list.
function upgradeAllowed(body, upgrade) {
    if (body && body._tutBorrowing) return false;
    if (!body || !body._tutorialLock) return true;
    for (const c of (upgrade.class || [])) {
        if (!c) continue;
        // Entries are usually raw definition KEYS ('twin', 'pentaShot') from
        // entity.js; also match the resolved LABEL so lessons can use display
        // names ("Penta Shot").
        if (typeof c === 'string') {
            if (body._tutorialLock.includes(normalise(c))) return true;
            const def = Class[c];
            if (def && body._tutorialLock.includes(normalise(def.LABEL))) return true;
            continue;
        }
        if (body._tutorialLock.includes(normalise(c.LABEL)) ||
            body._tutorialLock.includes(normalise(c.NAME)) ||
            body._tutorialLock.includes(normalise(c.index))) return true;
    }
    return false;
}

// Classes a lesson may morph the learner into outright (for tanks the upgrade
// tree cannot reach from the current one). Allowlisted so a crafted TUT packet
// cannot morph anyone into an arbitrary class.
const MORPHS = ['director', 'overlord', 'auto3', 'auto5', 'smasher', 'pentaShot',
    'destroyer', 'pounder', 'sniper', 'machineGun'];

function morph(body, className) {
    try {
        const key = String(className || '').trim();
        if (!MORPHS.includes(key) || !Class[key]) return;
        // define() APPENDS upgrades; clear the old tank's choices first.
        body.upgrades = [];
        body.define(key);
        body.refreshBodyAttributes();
    } catch (e) { util.warn("tutorial: morph failed - " + (e && e.message)); }
}

// "Try this tank for a moment": morph, saving the learner's own tank for untry().
// Only the FIRST try saves, so repeated tries still restore the real choice.
// While borrowing, evolving is off (menu hidden, U packets dropped) so the
// loaned tank cannot be evolved.
function tryTank(body, className) {
    if (!body) return;
    const key = String(className || '').trim();
    if (!MORPHS.includes(key) || !Class[key]) return;
    if (!body._tutSavedDefs && Array.isArray(body.defs)) body._tutSavedDefs = body.defs.slice();
    body._tutBorrowing = key;
    morph(body, key);
}
function untry(body) {
    if (!body) return;
    const saved = body._tutSavedDefs;
    body._tutBorrowing = null;
    if (!saved) return;
    body._tutSavedDefs = null;
    try {
        body.upgrades = [];
        body.define(saved);
        body.refreshBodyAttributes();
    } catch (e) { util.warn("tutorial: untry failed - " + (e && e.message)); }
}
function borrowing(body) { return !!(body && body._tutBorrowing); }

// The "pick an upgrade" step allows exactly ONE evolve: at level 45 the menu
// refills instantly, so a double click could chain tiers. The first pick
// spends the permission.
function noteUpgraded(body) {
    const g = gateOf(body);
    if (g && g._tutorialAllow) g._tutorialAllow.delete('upgrade');
}

// Back to the spawn tank (and forget any loan) for a clean tank-chapter replay.
function baseTank(body) {
    if (!body) return;
    try {
        body._tutSavedDefs = null;
        body._tutBorrowing = null;
        body.upgrades = [];
        body.define(Config.spawn_class);
        body.refreshBodyAttributes();
    } catch (e) { util.warn("tutorial: base tank failed - " + (e && e.message)); }
}

// Clear shop state (drill, gear, kit, sidearm) so the shop chapter replays:
// owned items cannot be re-bought and a full kit refuses the lesson's Medkit.
function resetShop(socket) {
    try {
        const shop = require('./terrain/shop.js');
        socket.shop = shop.freshState();
        const body = socket.player && socket.player.body;
        if (body && !body.isDead()) {
            shop.detachSidearm(body);
            shop.applyPassives(body);
        }
        shop.talkState(socket);
    } catch (e) { util.warn("tutorial: shop reset failed - " + (e && e.message)); }
}

// Base-lesson fallback: give the learner their practice base outright.
function giveBase(plotIndex, body) {
    try { require('./terrain/outposts.js').claimSite(plotIndex, body); } catch (e) { }
}

// Keep each practice bot on the learner's screen. Backstop for what the
// duelist controller cannot cover (knockback, the stationary dummy). The radius
// is bounded by the VERTICAL view cull (fov * 0.5625, ~1125 units), which is
// much tighter than the horizontal one.
const LEASH_RADIUS = 820;

function tickLeash() {
    for (let i = 0; i < bots.length; i++) {
        const slot = bots[i];
        const socket = owners[i];
        const player = socket && socket.player && socket.player.body;
        for (const key of ['dummy', 'fighter', 'boss']) {
            const o = slot[key];
            if (!o || o.isDead()) continue;
            // anchor on the learner, not a fixed point
            const home = (player && !player.isDead()) ? player : plots.plotPoint(i, key);
            if (key === 'boss' && o.bossHome && player && !player.isDead()) { o.bossHome.x = player.x; o.bossHome.y = player.y; }
            const dx = o.x - home.x, dy = o.y - home.y;
            const d = Math.hypot(dx, dy);
            if (d <= LEASH_RADIUS) continue;
            // clamp to the leash edge rather than snapping home
            const k = LEASH_RADIUS / d;
            o.x = home.x + dx * k;
            o.y = home.y + dy * k;
            if (o.velocity) { o.velocity.x *= 0.2; o.velocity.y *= 0.2; }
            plots.keepInPlot(o, i);
        }
    }
}

// Publish each learner's arena fence onto their body. The fence is applied in
// entity.confinementToTheseEarthlyShackles() with the same soft push as the
// room border.
function tickBaseGuard() {
    for (let i = 0; i < owners.length; i++) {
        const socket = owners[i];
        const body = socket && socket.player && socket.player.body;
        if (!body || body.isDead()) continue;
        body.arenaBounds = plots.plotFence(i);
    }
}

// The fight lesson promises "it can't kill you". While a practice bot or boss
// is up in a plot:
//  - the learner's health never drops below HEALTH_FLOOR;
//  - the fighter re-targets the learner's CURRENT body (respawns make a new one);
//  - a fighter (or boss) alive past its patience wilts, so the lesson cannot soft-lock.
const HEALTH_FLOOR = 0.2;
const FIGHTER_PATIENCE_MS = 60000;
const FIGHTER_WILT_MS = 30000;
// The practice boss gets longer, then wilts at the same rate.
const BOSS_PATIENCE_MS = 75000;
function tickSafety() {
    const now = Date.now();
    for (let i = 0; i < owners.length; i++) {
        const slot = bots[i];
        const socket = owners[i];
        const body = socket && socket.player && socket.player.body;
        const live = (o) => o && !o.isDead();
        const threat = live(slot.fighter) || live(slot.boss);
        if (threat && body && !body.isDead() && body.health && body.health.max) {
            const floor = body.health.max * HEALTH_FLOOR;
            if (body.health.amount < floor) body.health.amount = floor;
        }
        const f = slot.fighter;
        if (live(f)) {
            if (body && !body.isDead()) f.tutorialFoe = body;
            if (!f._tutBornAt) f._tutBornAt = now;
            const over = now - f._tutBornAt - FIGHTER_PATIENCE_MS;
            if (over > 0 && f.health && f.health.max) {
                const cap = f.health.max * Math.max(0, 1 - over / FIGHTER_WILT_MS);
                if (cap <= f.health.max * 0.02) { killBot(f); slot.fighter = null; }
                else if (f.health.amount > cap) f.health.amount = cap;
            }
        }
        const b = slot.boss;
        if (live(b)) {
            if (!b._tutBornAt) b._tutBornAt = now;
            const over = now - b._tutBornAt - BOSS_PATIENCE_MS;
            if (over > 0 && b.health && b.health.max) {
                const cap = b.health.max * Math.max(0.01, 1 - over / FIGHTER_WILT_MS);
                if (b.health.amount > cap) b.health.amount = cap;
                if (b.shield && b.shield.amount > 0) b.shield.amount = 0;
            }
        }
    }
}

// Drop plots whose owner vanished (disconnect, crash, tab close).
function tickReap() {
    for (let i = 0; i < owners.length; i++) {
        const socket = owners[i];
        if (!socket) continue;
        if (socket.closed || socket.readyState === 3 || socket._tutorialPlot !== i) {
            owners[i] = null;
            if (socket) socket._tutorialPlot = null;
            clearBots(i);
        }
    }
}

module.exports = {
    claimPlot, releasePlot, plotOf, freePlots, spawnPointFor,
    resetBase, openBase, learnerColor,
    plotInfo, talkPlotInfo,
    spawnDummy, spawnFighter, clearBots,
    spawnChest, spawnBoss, clearBoss, setBanked, grantKit, grantArm, grantGear,
    lockUpgrades, unlockUpgrades, upgradeAllowed, morph, tryTank, untry, borrowing, noteUpgraded, giveBase,
    setAllowed, allows, allowsAll, allowsStat, noteStatSpent, baseTank, resetShop,
    setStats, fillStats, grantPoints, spendRest, teleport, teleportTo, setCommand, heal,
    tickLeash, tickReap, tickBaseGuard, tickGlide, tickSafety,
    plotCount: plots.plotCount,
    plotPoint: plots.plotPoint,
};
