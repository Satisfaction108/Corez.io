// TUTORIAL SESSION
//
// Runtime state for the tutorial server: which learner owns which plot, and the
// scripted bots each plot spawns on demand.
//
// Plot isolation is what makes one room feel like nine private worlds. See
// terrain/tutorialPlots.js for the geometry and why culling guarantees privacy.

const plots = require('./terrain/tutorialPlots.js');

// socket -> plot index, and the reverse occupancy table.
const owners = new Array(plots.plotCount()).fill(null);

// Per-plot scripted bots: { dummy: Entity|null, fighter: Entity|null }
const bots = new Array(plots.plotCount()).fill(null).map(() => ({ dummy: null, fighter: null, boss: null, chest: null }));

function plotOf(socket) {
    return socket && socket._tutorialPlot != null ? socket._tutorialPlot : -1;
}

// Claim the first free plot. Returns -1 when the server is full, which the
// caller turns into a "come back in a moment" rejection rather than dropping
// two learners into one world.
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

// The practice base starts neutral and LOCKED: shots bounce off it until the
// base lesson opens it, so nobody captures it by accident three chapters
// early. A new learner in the plot must never inherit the last one's base.
function resetBase(plotIndex) {
    try { require('./terrain/outposts.js').resetSite(plotIndex, true); } catch (e) { }
}
function openBase(plotIndex) {
    try { require('./terrain/outposts.js').lockSite(plotIndex, false); } catch (e) { }
}

// Learners play on TEAM_BLUE internally (vault and base rules key off it), but
// their tank wears a colour from the Dig Royale palette like it would in a
// raid. Red is left out: every practice bot and boss is red.
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

// Everything the client needs to know about its own arena, shipped in the TUTI
// packet. The client cannot derive any of it: it is handed the room and the
// terrain, but nothing tells it how the room was divided.
//
// The landmarks matter beyond drawing markers. Without them the lesson script
// falls back on "the first outpost in the list" and "the nearest rock", both of
// which happily point at a NEIGHBOUR's arena - the outpost list is room-wide
// and the terrain renderer holds every rock in the room. Every world lookup on
// the client is filtered through `arena` for that reason.
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
        vault: pt('vault'),            // the one vault on this ground
        outpost: pt('outpost'),        // the practice base
        shop: pt('shop'),
        chest: pt('chest'),
        boss: pt('boss'),
        // The round island the floor is painted on (and the fence).
        island: { x: Math.round(c.x), y: Math.round(c.y), r: plots.ISLAND_R },
        clearingR: plots.CLEARING.r,
        // Frame for the full map, and the filter for every world lookup.
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

// A loot chest beside the learner. Always carries a Medkit so the kit lesson
// that follows has something in slot one to fire.
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

// A training copy of a raid boss: the real class, the real guns, a fraction
// of the health, and its shots scaled so it can chip the learner without
// dumping them. It erupts gems on death exactly like the live one.
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

// Banked gems for the shop lesson - the shop takes nothing else.
function setBanked(body, n) {
    if (!body) return;
    const gems = require('./terrain/gems.js');
    gems.setBanked(body, Math.max(0, n | 0));
    gems.talkGems(body, 0);
}

// Kit and sidearm hand-outs, so the lessons can show the item before the
// learner has bought anything.
function grantKit(socket, id) {
    const shop = require('./terrain/shop.js');
    return shop.grantKit(socket, String(id || 'medkit'));
}
// A running gear item, so the lesson can point at the GEAR row and its
// timer before the learner has bought one.
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
    shop.talkState(socket, item.name + " mounted. Fire it with right click.", true);
    return true;
}

// Shared setup for both practice targets. They are real tanks on the enemy
// team so damage, health bars, death and gem drops all behave exactly as they
// will in a real match - the tutorial teaches the real game, not a mock of it.
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

// Is this spot clear enough to drop a tank on? It must be on the island and
// out of solid rock, which would wedge it in the collision geometry where the
// learner cannot reach it.
function spawnClear(plotIndex, x, y) {
    if (!plots.onIsland(plotIndex, x, y, 200)) return false;

    const grid = global.gameManager && global.gameManager.terrainGrid;
    if (grid && grid.nearestRock) {
        const rock = grid.nearestRock(x, y, 150);
        if (rock && rock.alive) return false;
    }
    return true;
}

// Somewhere just off the learner's shoulder. Practice targets used to spawn at
// a fixed point in the arena, which meant the learner had to go looking for
// them - and if they had wandered, the target was off screen when it appeared
// and the lesson sat there waiting on a bot that was "there".
//
// The offset is a PREFERENCE, not a promise: it is tried first, then swept
// around the learner, because the one thing that matters is that the target
// lands somewhere reachable and visible.
function besidePlayer(plotIndex, dx, dy) {
    const socket = owners[plotIndex];
    const body = socket && socket.player && socket.player.body;
    const home = plots.plotPoint(plotIndex, 'dummy');
    if (!body || body.isDead()) return home;

    const want = Math.atan2(dy, dx);
    const dist = Math.hypot(dx, dy);
    // Sweep outward from the requested bearing so the fallback stays as close
    // to "just there, on your right" as the terrain allows.
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

// Bring the learner back to full. Used before a fight the lesson wants them to
// win, right after the lesson that deliberately chewed their health down.
function heal(body) {
    if (!body) return;
    if (body.health && body.health.max) body.health.amount = body.health.max;
    if (body.shield && body.shield.max) body.shield.amount = body.shield.max;
}

// A target that never moves and never shoots: the first kill should be about
// aiming and holding fire, nothing else.
function spawnDummy(plotIndex) {
  try {
    const slot = bots[plotIndex];
    if (!slot) return null;
    if (slot.dummy && !slot.dummy.isDead()) return slot.dummy;

    const o = baseTarget(besidePlayer(plotIndex, 400, -110), 'Practice Dummy');
    o.controllers = [];               // no AI at all
    o.define({ CONTROLLERS: [] }, false, false, false);
    o.settings.hasNoRecoil = true;    // its own guns never fire, but be sure
    slot.dummy = o;
    return o;
  } catch (e) { util.warn("tutorial: dummy spawn failed - " + (e && e.message)); return null; }
}

// The first opponent that shoots back.
//
// A Basic on a thin stat spread: people were dying to the old Penta Shot
// practice target, which taught panic instead of backing off. It should chip
// the health bar, not empty it.
const FIGHTER_STATS = [0, 0, 3, 1, 0, 1, 4, 3, 0, 0];

function spawnFighter(plotIndex) {
  try {
    const slot = bots[plotIndex];
    if (!slot) return null;
    if (slot.fighter && !slot.fighter.isDead()) return slot.fighter;

    const o = baseTarget(besidePlayer(plotIndex, 420, 130), 'Rookie');
    // Stay a Basic. baseTarget already defined spawn_class and levels to 45
    // so the tank is the same size as a real opponent.
    o.define({ CONTROLLERS: ["tutorialDuelist"] }, false, false, false);
    o.tutorialFoe = (owners[plotIndex] && owners[plotIndex].player)
        ? owners[plotIndex].player.body : null;
    o.botStatsFixed = true;
    o.botRespawnsRemaining = 0;
    setStats(o, FIGHTER_STATS);
    o.refreshBodyAttributes();
    // Outgoing shots (and rams) are scaled so a stray volley cannot dump a
    // learner. A level-45 Basic with this spread can chip the bar, not empty it.
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
// Lessons talk in the order the player can see, so the mapping lives here once.
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
    // set() clamps to caps and refunds the overflow into points, which is
    // exactly right: asking a rammer for bullet damage should hand the point
    // back rather than silently vanish it.
    const spent = raw.reduce((a, b) => a + b, 0);
    const before = body.skill.raw.reduce((a, b) => a + b, 0);
    body.skill.set(raw);
    body.skill.points = Math.max(0, body.skill.points + before - spent);
    body.refreshBodyAttributes();
}

// Hand the learner points to spend. Used when a morph opens up a stat they
// have never seen (a rammer's Engine Acceleration) after everything was spent.
function grantPoints(body, n) {
    if (!body || !body.skill) return;
    body.skill.points = Math.max(body.skill.points, n | 0);
}

// Every stat this tank can actually use goes to its cap, except one that is
// left empty with exactly `spare` points in hand to fill it.
//
// The rammer chapter needs this: which stats a Smasher can use, and what they
// cap at, is a property of the class definition, so hard-coding a number here
// would silently drift the moment the tank is retuned. Ask the skill object.
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

// Put the learner on top of the landmark the lesson is about. Walking 2000
// units in silence is not a lesson, and the edge arrow only helps if you
// already know why you are walking.
//
// Glided, not snapped: an instant jump reads as a bug or a disconnect, and the
// client's camera lerps toward the body anyway, so a hard set produced a
// lurching catch-up. tickGlide walks it there over a few hundred ms - fast
// enough not to be a journey, slow enough to be legible as movement.
const GLIDE_MS = 420;

function teleport(socket, key) {
    const i = plotOf(socket);
    const body = socket && socket.player && socket.player.body;
    if (i < 0 || !body || body.isDead()) return;
    const layoutKey = key;
    let p;
    try { p = plots.plotPoint(i, layoutKey); } catch (e) { return; }
    // Land beside a structure rather than inside it: dropping a tank on top of
    // a chamber ring wedges it in the collision geometry. The vault pad is
    // meant to be stood on, so it gets no offset.
    const off = layoutKey === "outpost" ? -260 : 0;
    teleportTo(socket, p.x + off, p.y);
}

// Glide to an explicit world point, clamped to this learner's arena. Used when
// the client has already picked the marked rock and needs to land next to THAT
// cell, not a generic landmark that can be on the other side of the wall.
function teleportTo(socket, x, y) {
    const i = plotOf(socket);
    const body = socket && socket.player && socket.player.body;
    if (i < 0 || !body || body.isDead()) return;
    x = +x; y = +y;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const f = plots.plotFence(i);
    const dx = x - f.cx, dy = y - f.cy, d = Math.hypot(dx, dy), lim = f.r - 150;
    if (d > lim) { x = f.cx + dx * (lim / d); y = f.cy + dy * (lim / d); }
    if (Math.hypot(body.x - x, body.y - y) < 120) return;
    body._tutorialGlide = {
        fromX: body.x, fromY: body.y,
        toX: x, toY: y,
        at: Date.now(),
    };
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
        // Ease in and out so it starts and stops without a jerk.
        const e = t * t * (3 - 2 * t);
        body.x = g.fromX + (g.toX - g.fromX) * e;
        body.y = g.fromY + (g.toY - g.fromY) * e;
        if (body.velocity) { body.velocity.x = 0; body.velocity.y = 0; }
        if (body.accel) { body.accel.x = 0; body.accel.y = 0; }
    }
}

// Force a player command flag (the drone lesson turns auto-fire off so the
// learner sees drones recall when they release the button).
function setCommand(socket, name, on) {
    const p = socket && socket.player;
    if (!p || !p.command) return;
    if (!['autofire', 'autospin', 'override', 'autoalt', 'spinlock'].includes(name)) return;
    p.command[name] = !!on;
}

// ─── step gating ──────────────────────────────────────────────────────────
//
// A tutorial step teaches ONE thing, and a learner who wanders off to dump
// stat points or evolve into something the next lesson is not written for
// ends up in a state the script cannot recover from. So each step declares
// what it permits, and everything else is refused at the socket - not merely
// hidden in the UI, because the keyboard shortcuts bypass the UI entirely.
//
// Movement and firing are never gated: being unable to drive feels broken,
// and every lesson is easier to follow while you can move.
const CAPS = ['stats', 'upgrade', 'bank', 'shop', 'kit'];

function setAllowed(body, csv) {
    const list = String(csv || '').split(',').map(x => x.trim()).filter(Boolean);
    const caps = new Set();
    // "stats" opens the whole bar; "stats:6" opens exactly one of them, by the
    // index the skill bar (and the x packet) uses. The per-stat objectives are
    // about ONE stat, and a learner who dumps the lot into the first bar has
    // skipped nine lessons without noticing. Carried on `allow` rather than a
    // command of its own because allow is re-sent on every step, so the lock
    // cannot outlive the objective that set it.
    body._tutorialStat = -1;
    for (const item of list) {
        const [cap, arg] = item.split(':');
        if (!CAPS.includes(cap)) continue;
        caps.add(cap);
        if (cap === 'stats' && arg !== undefined) {
            const i = parseInt(arg, 10);
            if (i >= 0 && i <= 10) body._tutorialStat = i;
        }
    }
    body._tutorialAllow = caps;
}

// Default-closed: if a step never declared its permissions, assume the strict
// set. A missing declaration should not silently unlock the whole game.
function allows(body, cap) {
    if (!Config.tutorial) return true;
    if (!body || !body._tutorialAllow) return false;
    return body._tutorialAllow.has(cap);
}

// Which stat index the current step permits (-1 = any).
function allowsStat(body, index) {
    if (!Config.tutorial) return true;
    if (!allows(body, 'stats')) return false;
    const only = body._tutorialStat;
    return only === undefined || only < 0 || only === index;
}

// ─── forced upgrade path ──────────────────────────────────────────────────
//
// The tutorial teaches one build at a time: a bullet tank first, a drone tank
// second. Rather than trusting the learner to pick the right box out of six,
// the class menu is filtered down to the single tank the lesson is about.

const normalise = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// The lock takes a comma-separated PATH, not a single tank: a target such as
// Penta Shot sits several tiers up the tree (basic - Twin - Triple Shot -
// Penta Shot), and a menu filtered to only the final tank shows NOTHING at
// tier one - the learner stares at an empty upgrade box. Naming every rung
// lets each tier offer exactly one choice: the next step along the path.
function lockUpgrades(body, path) {
    const names = String(path || '').split(',').map(normalise).filter(Boolean);
    body._tutorialLock = names.length ? names : null;
}

function unlockUpgrades(body) {
    body._tutorialLock = null;
}

// Consulted by sockets.js while it builds the offered-upgrade list.
function upgradeAllowed(body, upgrade) {
    if (!body || !body._tutorialLock) return true;
    for (const c of (upgrade.class || [])) {
        if (!c) continue;
        // Entries here are usually raw definition KEYS ('twin', 'pentaShot')
        // - entity.js pushes the unresolved strings - but resolve to the
        // class object too and match its display label, so lessons can name
        // tanks the way players see them ("Penta Shot").
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

// Turn the learner's tank into a specific class outright. The drone lesson
// needs this: by then they are a Penta Shot at the top of the bullet branch,
// and the upgrade tree cannot reach Director from there - no menu filtering
// can teach a drone tank to someone who already finished a different branch.
// Allowlisted so the TUT packet can never morph anyone into an arbitrary tank.
// Every tank the curriculum walks through, plus the bullet tank it returns to
// between chapters. Allowlisted so a crafted TUT packet cannot morph anyone
// into an arbitrary class.
const MORPHS = ['director', 'overlord', 'auto3', 'auto5', 'smasher', 'pentaShot'];

function morph(body, className) {
    try {
        const key = String(className || '').trim();
        if (!MORPHS.includes(key) || !Class[key]) return;
        body.define(key);
        body.refreshBodyAttributes();
    } catch (e) { util.warn("tutorial: morph failed - " + (e && e.message)); }
}

// Keep each practice bot on the learner's screen.
//
// The duelist controller already circles the player, so this is a backstop for
// the cases the controller cannot cover: knockback, a bot spawned before the
// player moved, and the stationary dummy after the learner has walked off. The
// radius is set by the VERTICAL view cull (fov * 0.5625, about 1125 units),
// which is far tighter than the horizontal one - a bot 1200 units above the
// learner is culled out of their client entirely and reads as "it vanished".
const LEASH_RADIUS = 820;

function tickLeash() {
    for (let i = 0; i < bots.length; i++) {
        const slot = bots[i];
        const socket = owners[i];
        const player = socket && socket.player && socket.player.body;
        for (const key of ['dummy', 'fighter', 'boss']) {
            const o = slot[key];
            if (!o || o.isDead()) continue;
            // Anchor on the learner, not on a fixed point: the lesson has to
            // happen where they can see it, wherever that is.
            const home = (player && !player.isDead()) ? player : plots.plotPoint(i, key);
            if (key === 'boss' && o.bossHome && player && !player.isDead()) { o.bossHome.x = player.x; o.bossHome.y = player.y; }
            const dx = o.x - home.x, dy = o.y - home.y;
            const d = Math.hypot(dx, dy);
            if (d <= LEASH_RADIUS) continue;
            // Slide it back to the edge of its leash rather than snapping it
            // home, so a bot circling the learner is nudged, not teleported.
            const k = LEASH_RADIUS / d;
            o.x = home.x + dx * k;
            o.y = home.y + dy * k;
            if (o.velocity) { o.velocity.x *= 0.2; o.velocity.y *= 0.2; }
            plots.keepInPlot(o, i);
        }
    }
}

// Hold every learner inside their own arena, and out of its enemy base.
//
// The arena fence itself is NOT applied here: entity.confinementToTheseEarthly-
// Shackles() does it, using the same soft push the real room border uses, so
// the edge of the training ground feels like the edge of the real map instead
// of a snap-back. All this loop does is publish the bounds onto the body and
// keep the lethal base out of reach.
function tickBaseGuard() {
    for (let i = 0; i < owners.length; i++) {
        const socket = owners[i];
        const body = socket && socket.player && socket.player.body;
        if (!body || body.isDead()) continue;
        body.arenaBounds = plots.plotFence(i);
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
    lockUpgrades, unlockUpgrades, upgradeAllowed, morph,
    setAllowed, allows, allowsStat,
    setStats, fillStats, grantPoints, teleport, teleportTo, setCommand, heal,
    tickLeash, tickReap, tickBaseGuard, tickGlide,
    plotCount: plots.plotCount,
    plotPoint: plots.plotPoint,
};
