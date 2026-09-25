import { global } from "./global.js";
import { util } from "./util.js";
import { gui } from "./socketinit.js";
import { gameSound } from "./sound.js";

// ── Corez.io training ──────────────────────────────────────────────────
// Nine short chapters, each a handful of do-it steps, with a chapter list so
// it never feels endless. Players can jump to any chapter, skip one, or skip
// the lot, and a return visit picks up where they left off (localStorage).
//
//   1 Basics          drive, aim, shoot, auto-fire / auto-spin, the map, keys
//   2 Your tank       stat groups by doing, pick an upgrade, try a Destroyer
//   3 Mining          break rock, grab gems, ore tiers, satchel
//   4 Banking & bases vault deposit, capture a base, bank there, base rules
//   5 Shops & gear    shop pad, drill, gear, kit items (Medkit, Rock Barrage), sidearm
//   6 Loot & bosses   chest, practice boss, boss loot, blooms / events / twists
//   7 The raid        storm drill, raid clock, dying, score and streaks
//   8 Ranked          ranks, placement, gemdust (guests: sign in one-liner)
//   9 Final fight     beat the Rookie, then "You're ready" → Play
//
// The card is DOM (tutorial.css, injected from here so the menu stylesheet is
// untouched). World markers are canvas, drawn from drawGameplay() so they share
// the camera; HUD highlights are canvas too, drawn at the very end of the frame
// from the game's own clickable regions.
//
// Nothing can soft-lock: every do-it step has an idle hint, a "Skip this step"
// link once you look stuck and a hard give-up that stages the outcome on the
// server. Info steps have a "Got it" button. Each chapter stages everything it
// needs on entry, so starting from any chapter works. The server keeps its own
// promises too (tutorialSession.tickSafety: health floor while a bot or boss
// is up, fighters and bosses that wilt if the fight drags on).

// home.js reads the same key to decide whether to show the "new? start here"
// badge. Kept at _v1 so people who already finished are not sent back.
const STORAGE_KEY = "digRoyaleTutorialDone_v1";
// Chapter progress for resuming: { ch: index to resume at, done: [chapter ids] }
const PROGRESS_KEY = "dwTutProgress_v2";
// Set right before we leave for the menu when the learner pressed Play; home.js
// sees it and starts a real game as soon as the menu is ready.
const PLAY_AFTER_KEY = "dwPlayAfterTutorial";

// socketinit.js pings this on every terrain rock event.
window.dwTutorialRock = () => { window.dwRocksBroken = (window.dwRocksBroken || 0) + 1; };

// ── palette (flat, matches home.css) ───────────────────────────────────
const INK = "#0c0a0e";
const GOLD = "#f2b83c";
const GOLD_RGB = "242,184,60";
const EMERALD = "#3fcf7a";
const FOE = "#e86262";
const DISPLAY = "'Lilita One', Rubik, Ubuntu, sans-serif";

// ── keybind labels ─────────────────────────────────────────────────────
const DEFAULTS = {
    KEY_UP: "W", KEY_DOWN: "S", KEY_LEFT: "A", KEY_RIGHT: "D",
    KEY_AUTO_FIRE: "E", KEY_AUTO_SPIN: "C", KEY_OVER_RIDE: "R",
    KEY_TOGGLE_MAP: "M", KEY_CLASS_TREE: "T", KEY_MAX_STAT: "F", KEY_CHAT: "Enter",
    KEY_UPGRADE_ATK: "1", KEY_UPGRADE_SHI: "0", KEY_UPGRADE_MIN: "-",
    KEY_KIT_1: "Z", KEY_KIT_2: "Q", KEY_KIT_3: "N",
};
let keyLabelCache = null;
function lbl(id) {
    if (!keyLabelCache) {
        keyLabelCache = {};
        let kb = {};
        try {
            const raw = localStorage.getItem("keybinds");
            if (raw && raw.startsWith("{")) kb = JSON.parse(raw) || {};
        } catch (e) { }
        for (const k of Object.keys(DEFAULTS))
            keyLabelCache[k] = (kb[k] && kb[k][0]) || DEFAULTS[k];
    }
    return keyLabelCache[id] || DEFAULTS[id] || id;
}

// ── small math ─────────────────────────────────────────────────────────
const T = () => performance.now();
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = t => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
const SW = () => global.screenWidth;
const SH = () => global.screenHeight;
// Screen-space canvas scale (edge arrow, highlights): tracks the viewport.
const US = () => clamp(Math.min(SW(), SH()) / 760, 0.7, 1.45);

function ctxWorld() { return window.dwCtx && window.dwCtx[1]; }
function ctxGui() { return window.dwCtx && window.dwCtx[2]; }

// The camera transform drawGameplay() hands us: px/py are already ratio-scaled.
function w2s(wx, wy, px, py, ratio) {
    return { x: -px + SW() / 2 + ratio * wx, y: -py + SH() / 2 + ratio * wy };
}

// ── audio stingers (built from the game's own synth primitives) ────────
function canSound() {
    try { return !!(gameSound && gameSound._ready && gameSound._ready()); }
    catch (e) { return false; }
}
function sfxObjective() {
    if (!canSound()) return;
    try {
        gameSound._tone({ freq: 523.25, type: "triangle", dur: 0.12, peak: 0.09, attack: 0.008 });
        gameSound._tone({ freq: 783.99, type: "triangle", dur: 0.2, peak: 0.08, delay: 0.09, attack: 0.01 });
        gameSound._ring({ freqs: [1046.5, 1568], dur: 0.22, peak: 0.03, delay: 0.12 });
    } catch (e) { }
}
function sfxAdvance() {
    if (!canSound()) return;
    try { gameSound._tone({ freq: 392, type: "sine", dur: 0.08, peak: 0.04, attack: 0.01 }); }
    catch (e) { }
}
function sfxFinale() {
    if (!canSound()) return;
    try {
        gameSound._ring({ freqs: [261.6, 329.63, 392], dur: 0.55, peak: 0.1 });
        gameSound._tone({ freq: 523.25, type: "sine", dur: 0.5, peak: 0.07, delay: 0.16, attack: 0.03 });
    } catch (e) { }
}

// ── terrain access ─────────────────────────────────────────────────────
function terr() {
    const t = window.terrainRenderer;
    return (t && t.ready && t._world && t._cellPolys) ? t : null;
}
function rockAt(t, k) {
    const cell = t._cellPolys.get(k);
    if (!cell) return null;
    const w = t._world;
    return { k, x: cell.cx * w.s - w.hw, y: cell.cy * w.s - w.hh };
}
function rockAlive(t, k) {
    return !!t && t._cellPolys.has(k) && !t._rockDead.has(k);
}

// ── staying inside our own arena ───────────────────────────────────────
// The room holds one arena per learner, but the terrain renderer and the
// vault/outpost lists are room-wide. Every world lookup goes through inArena()
// so no marker ever points into a neighbour's arena.
function arena() {
    const p = global.tutorialPlot;
    return (p && p.arena) ? p.arena : null;
}
function inArena(x, y) {
    const a = arena();
    if (!a) return true;
    return x >= a.x0 && x <= a.x1 && y >= a.y0 && y <= a.y1;
}
function landmark(key, kind, r) {
    const p = (global.tutorialPlot || {})[key];
    if (!p) return null;
    return { kind, x: p.x, y: p.y, r: r || 0 };
}
const me = () => global.entities.find(e => e.id === gui.playerid);
const px = () => global.player.renderx;
const py = () => global.player.rendery;
const distTo = (p) => p ? Math.hypot(p.x - px(), p.y - py()) : Infinity;

// A good rock: ore-bearing if asked, at a comfortable screen-relative
// stand-off so you have to aim at it rather than bump into it.
function acquireRock(wantOre) {
    const t = terr();
    if (!t) return null;
    const r = util.getRatio() || 1;
    const ideal = (Math.min(SW(), SH()) * 0.24) / r;
    let best = null, bestScore = Infinity;
    const keys = wantOre ? t._ore.keys() : t._rockHealth.keys();
    for (const k of keys) {
        if (!rockAlive(t, k)) continue;
        if (!wantOre && t._ore.has(k)) continue;     // plain rock: the one-shot demo
        const rk = rockAt(t, k);
        if (!rk || !inArena(rk.x, rk.y)) continue;
        const d = Math.hypot(rk.x - px(), rk.y - py());
        if (d < 50) continue;
        const score = Math.abs(d - ideal) + (d > ideal * 2 ? (d - ideal) * 0.25 : 0);
        if (score < bestScore) { bestScore = score; best = rk; }
    }
    if (!best && wantOre) return acquireRock(false);
    return best;
}
// Lock onto a rock once and keep it; glide over if it is far away.
function lockedRockTarget(wantOre) {
    if (state.lockedRock) return state.lockedRock;
    const r = acquireRock(wantOre);
    if (!r) return null;
    state.lockedRock = { kind: "rock", ...r };
    const dx = px() - r.x, dy = py() - r.y, d = Math.hypot(dx, dy) || 1;
    if (d > 700) tut("gotoxy", r.x + dx / d * 260, r.y + dy / d * 260);
    return state.lockedRock;
}
function lockedRockHealth() {
    const t = terr(), tg = state.lockedRock;
    if (!t || !tg) return 0;
    if (!rockAlive(t, tg.k)) return 1;
    const h = t._rockHealth.get(tg.k);
    return h === undefined ? 0 : clamp(1 - h, 0, 1);
}
function lockedRockDead() {
    const t = terr(), tg = state.lockedRock;
    return !!(t && tg && !rockAlive(t, tg.k));
}
function vaultPad() {
    const own = landmark("vault", "pad", 95);
    if (own) return own;
    let best = null, bestD = Infinity;
    for (const v of (global.vaults || [])) {
        const d = distTo(v);
        if (d < bestD) { bestD = d; best = { kind: "pad", x: v.x, y: v.y, r: v.r || 95 }; }
    }
    return best;
}
const shopPad = () => landmark("shop", "pad", 95);
const basePad = () => landmark("outpost", "pad", 95);

// The client is never told its team outright; gui.color starts with it.
function myTeam() {
    const c = String(gui.color || "");
    if (c.indexOf("blue") === 0) return -1;
    if (c.indexOf("red") === 0) return -2;
    return 0;
}
const signedIn = () => {
    try { return document.documentElement.getAttribute("data-acct") === "user"; }
    catch (e) { return false; }
};

// ── server commands ────────────────────────────────────────────────────
// Only honoured by the tutorial server (TUT case in sockets.js); inert on a
// live server. Everything goes as strings so "0" never reads as truthy junk.
function tut(cmd, ...args) {
    try {
        global.canvas.socket.talk("TUT", cmd,
            ...(args.length ? args.map(a => String(a)) : [""]));
    } catch (e) { }
}
// A server command a little later, once a glide has landed. Cancelled if the
// step changes in the meantime, so a skipped step never spawns stale props.
function tutLater(ms, cmd, ...args) {
    const at = state.stepAt;
    setTimeout(() => { if (state.running && state.stepAt === at) tut(cmd, ...args); }, ms);
}

function practiceBot(name) {
    let best = null, bestD = Infinity;
    for (const e of global.entities) {
        if (!e || e.id === gui.playerid) continue;
        if (e.team === myTeam()) continue;
        if (!e.render || !e.render.draws) continue;
        if (name && !(e.name || "").includes(name)) continue;
        if (!inArena(e.x, e.y)) continue;
        const d = distTo(e);
        if (d < bestD) { bestD = d; best = e; }
    }
    return best;
}
function nearestNamed(names) {
    let best = null, bestD = Infinity;
    for (const e of global.entities) {
        if (!e || !e.index) continue;
        const m = global.mockups[String(e.index).split("-")[0]];
        if (!m || !names.includes(m.name)) continue;
        if (!inArena(e.x, e.y)) continue;
        const d = distTo(e);
        if (d < bestD) { bestD = d; best = e; }
    }
    return best;
}
const GEM_NAMES = ["Copper", "Azurite", "Core Shard", "Emerald", "Dropped Gems"];
const CHEST_NAMES = ["Copper Chest", "Epic Chest"];
const BOSS_NAMES = ["Vault Warden", "Magma Drillhead", "Geode Colossus", "Shard Wraith"];
const nearestGem = () => nearestNamed(GEM_NAMES);
const nearestChest = () => nearestNamed(CHEST_NAMES);
function bossEntity() {
    const b = nearestNamed(BOSS_NAMES);
    if (b) return b;
    // mockup names can lag a define; the entity name is set server-side
    for (const e of global.entities) {
        if (e && BOSS_NAMES.includes(e.name) && inArena(e.x, e.y)) return e;
    }
    return null;
}
function hpFrac(e) {
    if (!e || e.health === undefined) return 1;
    const h = typeof e.health === "object" ? e.health : { amount: e.health, max: 1 };
    const max = h.max || 1;
    return clamp((h.amount != null ? h.amount : max) / max, 0, 1);
}
function shopState() { return (global.shop && global.shop.state) || {}; }
function kitCount(id) { return ((shopState().kit || {})[id]) | 0; }
function kitTotal() {
    const k = shopState().kit || {};
    let n = 0;
    for (const id in k) n += k[id] | 0;
    return n;
}
function gearCount() {
    const g = shopState().gear;
    if (!g) return 0;
    return Array.isArray(g) ? g.length : Object.keys(g).length;
}
function kitKeyFor(id) {
    const ko = shopState().kitOrder || [];
    const i = ko.indexOf(id);
    return ["KEY_KIT_1", "KEY_KIT_2", "KEY_KIT_3"][Math.max(0, i)] || "KEY_KIT_1";
}

// ── our base (outpost) ─────────────────────────────────────────────────
// global.outpostState is room-wide; match on the site at our arena's spot.
function baseState() {
    const mine = (global.tutorialPlot || {}).outpost;
    if (!mine) return null;
    for (const o of (global.outpostState || [])) {
        const site = (global.outposts || []).find(x => x.id === o.id);
        if (!site) continue;
        if (Math.hypot(site.x - mine.x, site.y - mine.y) > 200) continue;
        return o;
    }
    return null;
}

// ── skill bars ─────────────────────────────────────────────────────────
// Display order: 0 body dmg, 1 health, 2 bullet speed, 3 bullet health,
// 4 penetration, 5 bullet dmg, 6 reload, 7 move speed, 8 regen, 9 shield,
// 10 mining power. gui.skills stores 0..9 reversed; mining is entry 10.
function statSkill(i) { return (gui.skills || [])[i === 10 ? 10 : 9 - i] || null; }
function groupAmount(group) {
    let n = 0;
    for (const i of group) { const sk = statSkill(i); if (sk) n += sk.amount | 0; }
    return n;
}
function groupRoom(group) {
    let n = 0;
    for (const i of group) { const sk = statSkill(i); if (sk) n += Math.max(0, (sk.cap | 0) - (sk.amount | 0)); }
    return n;
}
const GUN_STATS = [2, 3, 4, 5, 6];
const BODY_STATS = [0, 1, 7, 8, 9];
const MINE_STATS = [10];

// How far the cursor has swung, in radians, since the step began.
function aimSweep() {
    const a = Math.atan2(global.target.y, global.target.x);
    if (state.aimLast === null) { state.aimLast = a; return state.aimTotal; }
    let d = a - state.aimLast;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    state.aimTotal += Math.abs(d);
    state.aimLast = a;
    return state.aimTotal;
}

// ── state ──────────────────────────────────────────────────────────────
const state = {
    running: false,
    step: -1,
    stepAt: 0,
    completedAt: 0,
    phase: "idle",        // idle | menu | active | clearing | final | finished
    target: null,         // {kind:'rock'|'gem'|'foe'|'pad'|'self'|'zone', x, y, ...}
    base: {},             // per-step baseline
    sub: 0,               // sub-phase inside a step
    subAt: 0,
    bursts: [],
    aimTotal: 0,
    aimLast: null,
    lockedRock: null,
    lastBreak: null,
    seen: false,          // a spawned prop (bot, chest, boss) was seen alive
    askAt: 0,
    bankPeak: 0,
    kitPeak: 0,
    lastProg: 0,
    lastProgAt: 0,
    hint: false,
    edge: null,
    // input, observed rather than polled
    fireMs: 0,
    fireDown: false,
    altMs: 0,
    altDown: false,
    lastInputAt: 0,
    toggles: { fire: 0, spin: 0, override: 0 },
    evolveCount: 0,
    lastType: null,
    mapOpened: false,
    spinOn: false,
    hurtAt: 0,
    storm: null,          // the client-side storm drill
    progress: { ch: 0, done: [] },
};

function snapshot() {
    state.base = {
        x: px(), y: py(),
        carried: global.gems.carried | 0,
        banked: global.gems.banked | 0,
        points: gui.points | 0,
        drill: shopState().drill | 0,
        gear: gearCount(),
        kit: kitTotal(),
        stat: 0,
        evolve: state.evolveCount,
        fire: state.toggles.fire,
        spin: state.toggles.spin,
    };
    state.aimTotal = 0;
    state.aimLast = null;
    state.fireMs = 0;
    state.altMs = 0;
    state.mapOpened = false;
    state.spinOn = false;
    state.seen = false;
    state.lockedRock = null;
    state.flagAt = 0;
    state.baseSeen = false;
    const s = stepDef();
    if (s && s.stats) state.base.stat = groupAmount(s.stats);
}

// Points placed in the current stat step's bars. Measured against a baseline
// that only ever moves DOWN: the chapter's stat reset reaches us a moment
// after the step has started, and without this the learner would owe back
// every point the reset took away.
function statGain() {
    const s = stepDef();
    if (!s || !s.stats) return 0;
    const now = groupAmount(s.stats);
    if (now < state.base.stat) state.base.stat = now;
    return now - state.base.stat;
}
// app.js asks this per bar: dim and refuse clicks on every bar the current
// step is not teaching, and on all of them once its points are placed. The
// server enforces the same thing; this is so the locked bars LOOK locked.
window.dwTutStatOpen = (i) => {
    if (!state.running) return true;
    const s = stepDef();
    if (!s || state.phase !== "active") return false;
    if (s.stats) return s.stats.includes(i) && statGain() < s.need;
    return String(s.allow || "").split(",").includes("stats");
};

const mob = () => !!global.mobile;
const kc = (id) => `{{${id}}}`;

// ── the chapters ───────────────────────────────────────────────────────
// Card text markup: {{KEY_X}} bound keycap, [[x]] literal keycap, *bold*.
// title/text/hint may be functions (they re-render when their output changes).
// Step fields:
//   allow      what the server permits this step ("stats", "bank", ...)
//   ui         HUD part to highlight (skills | stats:a,b | upgrades | kit)
//   next       info step: a "Got it" button finishes it
//   extra      a small illustration under the text ("ores" | "keys")
//   target()   world marker for this frame, or null
//   progress() 0..1, drives the bar and the idle-hint timer
//   done()     true = step complete
//   giveUp     ms before we stage the outcome ourselves and move on
//   fallback() what "staging the outcome" means for this step
//   omit()     leave the step out on this device
const CHAPTERS = [
    // ── 1 ────────────────────────────────────────────────────────────
    {
        id: "basics", name: "Basics", mins: 1,
        blurb: "Moving, shooting and the keys you'll actually use.",
        steps: [
            {
                id: "move",
                title: "Move around",
                text: () => mob()
                    ? "Left stick moves, right stick aims. Drive around a bit."
                    : `${kc("KEY_UP")} ${kc("KEY_LEFT")} ${kc("KEY_DOWN")} ${kc("KEY_RIGHT")} to drive. Your gun points at the mouse, so move that around too.`,
                hint: () => mob()
                    ? "Push the left stick any way."
                    : `Hold ${kc("KEY_UP")} and move the mouse in a circle.`,
                praise: "nice",
                target: () => ({ kind: "self" }),
                progress: () => {
                    const d = Math.hypot(px() - state.base.x, py() - state.base.y);
                    return clamp(d / 320, 0, 1) * 0.5 + clamp(aimSweep() / (Math.PI * 2), 0, 1) * 0.5;
                },
                done: (p) => p >= 1,
                giveUp: 45000,
            },
            {
                id: "shoot",
                title: "Shoot",
                text: () => mob()
                    ? "Hold the right stick to shoot where it points."
                    : "Hold [[Left click]] to shoot. Try it on the rocks.",
                hint: "Keep holding it for a sec.",
                praise: "ok",
                target: () => ({ kind: "self" }),
                progress: () => clamp(state.fireMs / 1500, 0, 1),
                done: (p) => p >= 1,
                giveUp: 40000,
            },
            {
                id: "autos",
                title: () => state.sub === 0 ? "Auto-fire" : "Auto-spin",
                text: () => {
                    if (state.sub === 0) return mob()
                        ? "Tap *Autofire* and you shoot without holding anything. Tap it again to turn it off. Lots of people just leave it on."
                        : `${kc("KEY_AUTO_FIRE")} is auto-fire, you shoot without holding click. Press it again to turn it off. Lots of people just leave it on.`;
                    return mob()
                        ? "Now tap *Autospin*. You spin and shoot everywhere, good when you're surrounded. Turn it on, then off."
                        : `Now ${kc("KEY_AUTO_SPIN")}. You spin and shoot everywhere, good when you're surrounded. Turn it on, then off.`;
                },
                hint: () => state.sub === 0
                    ? (mob() ? "Tap Autofire, then tap it again." : `Press ${kc("KEY_AUTO_FIRE")} twice.`)
                    : (mob() ? "Tap Autospin, then tap it again." : `Press ${kc("KEY_AUTO_SPIN")} twice.`),
                praise: "cool",
                target: () => ({ kind: "self" }),
                progress: () => {
                    if (state.sub === 0) return clamp((state.toggles.fire - state.base.fire) / 2, 0, 1) * 0.5;
                    return 0.5 + (state.spinOn ? (global.autoSpin ? 0.25 : 0.5) : 0);
                },
                done: () => {
                    if (state.sub === 0) {
                        if (state.toggles.fire - state.base.fire >= 2) { setSub(1); sfxAdvance(); }
                        return false;
                    }
                    return state.spinOn && !global.autoSpin;
                },
                fallback: () => {
                    if (global.autoSpin) { global.autoSpin = false; tut("cmd", "autospin", 0); }
                },
                giveUp: 50000,
            },
            {
                id: "map",
                omit: mob,
                title: "Big map",
                text: () => `${kc("KEY_TOGGLE_MAP")} opens the big map. Bosses and the storm show up on it. Open it and close it.`,
                hint: () => `${kc("KEY_TOGGLE_MAP")} to open, ${kc("KEY_TOGGLE_MAP")} again to close.`,
                praise: "got it",
                progress: () => state.mapOpened ? (global.showBigMap ? 0.5 : 1) : 0,
                done: () => state.mapOpened && !global.showBigMap,
                fallback: () => { global.showBigMap = false; },
                giveUp: 40000,
            },
            {
                id: "keys",
                omit: mob,
                next: true,
                title: "Keys",
                text: "These are the ones you'll use most. You can change any of them in *Settings* > *Keybinds*.",
                extra: "keys",
                praise: "ok",
            },
        ],
    },

    // ── 2 ────────────────────────────────────────────────────────────
    {
        id: "tank", name: "Your tank", mins: 1.5,
        blurb: "Stats and upgrades.",
        // Fresh build: every point back in hand, the upgrade menu shut.
        prep: () => {
            tut("untry");
            // Back to the starting tank too: a replay should not start as
            // whatever you evolved into last time.
            tut("basetank");
            tut("stats", "0,0,0,0,0,0,0,0,0,0,0");
            tut("lock", "none");
        },
        steps: [
            {
                id: "statGun", stats: GUN_STATS, need: 3, ui: "stats:" + GUN_STATS.join(","),
                title: "Gun stats",
                text: () => mob()
                    ? "These bars are your stats. The lit up ones make your bullets better. Tap them *3 times*."
                    : "Bottom left are your stats. The lit up ones make your bullets better. Put *3 points* in with [[3]] to [[7]] or just click them.",
                hint: "Any of the lit up bars works.",
                praise: "stronger",
                onEnter: () => { if ((gui.points | 0) < 12) tut("points", 30); },
                progress: () => clamp(statGain() / 3, 0, 1),
                done: (p) => p >= 1 || groupRoom(GUN_STATS) === 0,
                giveUp: 50000,
            },
            {
                id: "statBody", stats: BODY_STATS, need: 2, ui: "stats:" + BODY_STATS.join(","),
                title: "Body stats",
                text: () => mob()
                    ? "These ones keep you alive. Tap *2 points* in."
                    : "These ones keep you alive. Put *2 points* in ([[1]] [[2]] [[8]] [[9]] [[0]]).",
                hint: "Shield takes hits before your health does, regen fills it back up.",
                praise: "tankier",
                progress: () => clamp(statGain() / 2, 0, 1),
                done: (p) => p >= 1 || groupRoom(BODY_STATS) === 0,
                giveUp: 50000,
            },
            {
                id: "statMine", stats: MINE_STATS, need: 2, ui: "stats:10",
                title: "Mining Power",
                text: () => mob()
                    ? "Last bar is *Mining Power*. You break rock way faster with it, most people fill it early. Tap it twice."
                    : `Last bar is *Mining Power*. You break rock way faster with it, most people fill it early. Press ${kc("KEY_UPGRADE_MIN")} twice.`,
                hint: () => mob() ? "It's the one at the very end." : `Hold ${kc("KEY_MAX_STAT")} and press a stat key to max it all at once.`,
                praise: "there we go",
                progress: () => clamp(statGain() / 2, 0, 1),
                done: (p) => p >= 1 || groupRoom(MINE_STATS) === 0,
                // The rest goes on a sensible build so the next chapters are
                // not played half-built. They can respec in a real raid.
                onDone: () => tut("spendrest"),
                fallback: () => tut("spendrest"),
                giveUp: 45000,
            },
            {
                id: "upgrade", allow: "upgrade", ui: "upgrades",
                title: "Upgrade",
                text: () => "Top left are tanks you can turn into. Pick whatever looks fun, there's no wrong one.",
                hint: () => mob() ? "Tap one of the tanks at the top." : `${kc("KEY_CLASS_TREE")} shows the whole upgrade tree.`,
                praise: () => tankName() ? `${tankName()}, nice` : "looks good",
                onEnter: () => { tut("unlock"); state.askAt = T(); },
                progress: () => state.evolveCount > state.base.evolve ? 1 : 0,
                // Nothing on offer (already top tier): count it as seen.
                done: () => state.evolveCount > state.base.evolve ||
                    (T() - state.stepAt > 5000 && !(gui.upgrades || []).length),
                settle: 900,
                onDone: () => tut("lock", "none"),
                fallback: () => tut("lock", "none"),
                giveUp: 60000,
            },
            {
                id: "families",
                title: "Destroyer",
                text: "You're a *Destroyer* for a sec. Big slow shots break rock fast, so it's a good mining tank. Break the marked rock.",
                hint: "Aim at the gold outline and shoot. Should take one or two.",
                praise: "boom",
                // Remember the learner's own pick before the loan lands, so
                // the next card can name the tank they actually get back.
                onEnter: () => { state.ownType = gui.type; tut("try", "destroyer"); },
                target: () => lockedRockTarget(false),
                progress: () => lockedRockHealth(),
                done: () => lockedRockDead() || (!state.lockedRock && T() - state.stepAt > 5000),
                onDone: () => tut("untry"),
                fallback: () => tut("untry"),
                giveUp: 45000,
            },
            {
                id: "familiesCard", next: true,
                title: "Tank types",
                text: () => `${state.ownType && tankName(state.ownType) ? `Your *${tankName(state.ownType)}*'s` : "Your tank's"} back. Rough idea: *Twin* and *Machine Gun* are for fighting, *Pounder* and *Sniper* dig fast, *Smasher* just rams through rock.`,
                praise: "ok",
            },
        ],
    },

    // ── 3 ────────────────────────────────────────────────────────────
    {
        id: "mining", name: "Mining", mins: 1,
        blurb: "Breaking rock and picking up gems.",
        prep: () => { if ((global.gems.carried | 0) > 3000) tut("gems", 0); },
        steps: [
            {
                id: "rock",
                title: "Break a rock",
                text: () => mob()
                    ? "Gems are inside the rocks. Shoot the glowing one till it breaks."
                    : `Gems are inside the rocks. Shoot the glowing one till it breaks. ${kc("KEY_AUTO_FIRE")} helps.`,
                hint: () => distTo(state.target) > 700 ? "Follow the arrow, it's close."
                    : "Better ore takes more hits, keep going.",
                praise: "nice",
                // What the satchel held before the rock broke, so the next
                // step can tell the gems were already picked up.
                onEnter: () => { state.mineCarry = global.gems.carried | 0; },
                target: () => lockedRockTarget(true),
                progress: () => lockedRockHealth(),
                done: () => {
                    if (!state.lockedRock && T() - state.stepAt > 5000) return true;
                    if (lockedRockDead()) { state.lastBreak = { x: state.lockedRock.x, y: state.lockedRock.y }; return true; }
                    return false;
                },
                fallback: () => { state.lastBreak = state.lockedRock ? { x: state.lockedRock.x, y: state.lockedRock.y } : null; },
                giveUp: 70000,
            },
            {
                id: "gems",
                title: "Pick up the gems",
                text: "Drive over them to pick them up. They disappear after like 10 seconds so be quick.",
                hint: "Just drive through them.",
                praise: "got em",
                // Gems picked up while the last card was still clearing count:
                // measure from before the rock broke, not from now.
                onEnter: () => {
                    if (state.mineCarry != null) state.base.carried = Math.min(state.base.carried, state.mineCarry);
                    state.mineCarry = null;
                },
                target: () => {
                    const g = nearestGem();
                    if (g) return { kind: "gem", x: g.x, y: g.y };
                    // The drop can land a beat after the step starts; mark the
                    // spot briefly, never after there is nothing left to grab.
                    if (state.lastBreak && T() - state.stepAt < 1500)
                        return { kind: "gem", x: state.lastBreak.x, y: state.lastBreak.y, ghost: true };
                    return null;
                },
                progress: () => clamp(((global.gems.carried | 0) - state.base.carried) / 15, 0, 1),
                done: () => {
                    if ((global.gems.carried | 0) > state.base.carried) return true;
                    // Nothing on the ground (never dropped, faded, or the
                    // satchel is full): hand some over and move on.
                    if (nearestGem()) state.flagAt = 0;
                    else if (!state.flagAt) state.flagAt = T();
                    if (T() - state.stepAt > 1500 && state.flagAt && T() - state.flagAt > 1500) {
                        tut("gems", Math.min(3900, (global.gems.carried | 0) + 60));
                        return true;
                    }
                    return false;
                },
                fallback: () => tut("gems", Math.max((global.gems.carried | 0) + 60, 90)),
                giveUp: 40000,
            },
            {
                id: "ores", next: true, extra: "ores",
                title: "Ore types",
                text: "Better ore takes more hits and is further from the middle. There's only *3 emeralds* per map. Broken rock grows back after about 30 seconds.",
                praise: "ok",
            },
            {
                id: "satchel", next: true,
                title: "Your satchel",
                text: "I gave you *3,900* gems. You can carry *4,000* max, and once you're full you can't pick up any more. Everyone can see that glow btw, so you're a target now.",
                onEnter: () => tut("gems", 3900),
                target: () => ({ kind: "self" }),
                praise: "ok",
            },
        ],
    },

    // ── 4 ────────────────────────────────────────────────────────────
    {
        id: "bank", name: "Banking and bases", mins: 1,
        blurb: "Keeping your gems safe, and getting a base.",
        prep: () => {
            // A replay starts from a neutral, locked base: owning it from
            // last time would let the vault step bank at the base instead
            // and the capture step finish before it began.
            tut("reset");
            try { global.canvas.socket.talk("vc"); } catch (e) { }
            if ((global.gems.carried | 0) < 300) tut("gems", 1200);
        },
        steps: [
            {
                id: "vault", allow: "bank:vault",
                title: () => global.vault.onPad ? "Deposit" : "Bank your gems",
                text: () => global.vault.onPad
                    ? "Stay on the pad till the bar fills. Getting hit cancels it."
                    : "If you die you drop what you're carrying. *Banked* gems are safe. Drive onto the rainbow vault.",
                hint: () => global.vault.onPad
                    ? "Hit *Deposit* in the panel."
                    : "Follow the arrow to the rainbow pad.",
                praise: "safe",
                onEnter: () => {
                    if ((global.gems.carried | 0) < 15) tut("gems", 1200);
                    const v = vaultPad();
                    if (!v || distTo(v) > 900) tut("goto", "vault");
                },
                target: () => vaultPad(),
                progress: () => {
                    const v = global.vault;
                    if (v.total > 0) return 0.35 + 0.65 * clamp(1 - v.remaining / v.total, 0, 1);
                    return v.onPad ? 0.35 : clamp(0.3 - distTo(vaultPad()) / 6000, 0, 0.3);
                },
                done: () => (global.gems.banked | 0) > state.base.banked && !(global.vault.total > 0),
                fallback: () => { tut("banked", (global.gems.banked | 0) + (global.gems.carried | 0)); tut("gems", 0); },
                giveUp: 90000,
            },
            {
                id: "capture",
                title: "Take the base",
                text: "Bases are the octagons around the map. Shoot the block in the middle till it breaks and it's yours.",
                hint: "Sit next to it and keep shooting. This one breaks fast.",
                praise: "yours now",
                onEnter: () => {
                    // The chapter prep already reset it. Resetting here too
                    // raced the owner flag: the old "yours" could still be on
                    // screen for a frame and pass the step.
                    tut("openbase");
                    tut("heal");
                    const b = basePad();
                    if (!b || distTo(b) > 700) tut("goto", "outpost");
                },
                target: () => basePad(),
                progress: () => {
                    const o = baseState();
                    if (!o) return 0;
                    if (o.o && o.o === gui.playerid) return 1;
                    return clamp(1 - (o.h === undefined ? 1 : o.h), 0, 0.95);
                },
                done: () => {
                    const o = baseState();
                    const mine = !!(o && o.o && o.o === gui.playerid);
                    // Trust "yours" only once the neutral base has been seen
                    // (or after a beat, if it really was yours already).
                    if (o && !mine) state.baseSeen = true;
                    return mine && (state.baseSeen || T() - state.stepAt > 1500);
                },
                settle: 400,
                fallback: () => tut("givebase"),
                giveUp: 75000,
            },
            {
                id: "baseBank", allow: "bank:base",
                title: "Bank at your base",
                text: "Your base works as a bank too. You only keep *80%*, but it's usually way closer than a vault. Drive on and deposit.",
                hint: () => global.vault.onPad ? "Hit *Deposit* in the panel." : "Drive onto the middle of your base.",
                praise: "nice",
                onEnter: () => {
                    tut("gems", 400);
                    // Jumped here without taking it? It's yours, so there is
                    // somewhere to bank.
                    const o = baseState();
                    if (!(o && o.o && o.o === gui.playerid)) tut("givebase");
                },
                target: () => basePad(),
                progress: () => clamp(((global.gems.banked | 0) - state.base.banked) / 200, 0, 1),
                done: () => (global.gems.banked | 0) > state.base.banked && !(global.vault.total > 0),
                fallback: () => { tut("banked", (global.gems.banked | 0) + Math.round((global.gems.carried | 0) * 0.8)); tut("gems", 0); },
                giveUp: 70000,
            },
            {
                id: "baseRules", next: true,
                title: "Why bases matter",
                text: "You respawn at your base (unless the storm is on it). Only you can stand on it, 10 seconds at a time. If someone shoots it you get an *UNDER ATTACK* warning, and whoever breaks it gets it.",
                target: () => basePad(),
                praise: "ok",
            },
        ],
    },

    // ── 5 ────────────────────────────────────────────────────────────
    {
        id: "shop", name: "Shops", mins: 1.5,
        blurb: "Spending banked gems on stuff that helps.",
        prep: () => {
            global.shop.dismissed = false;
            // Nothing bought yet, even on a replay: a Drill I from last time
            // makes "buy Drill I" impossible, a running magnet can't be
            // bought twice and a full kit refuses the Medkit.
            tut("shopreset");
            if ((global.gems.banked | 0) < 2500) tut("banked", 2500);
        },
        steps: [
            {
                id: "shopGo",
                title: "Shop",
                text: "Shops take *banked* gems, I put some in yours. Drive onto the teal pad to open it.",
                hint: "Follow the arrow to the teal hexagon.",
                praise: "ok",
                onEnter: () => {
                    const p = shopPad();
                    if (!p || distTo(p) > 900) tut("goto", "shop");
                },
                target: () => shopPad(),
                progress: () => clamp(1 - distTo(shopPad()) / 1400, 0, 0.9),
                done: () => !!global.shop.onPad,
                giveUp: 60000,
            },
            {
                id: "drill", allow: "shop:drill",
                title: "Buy Drill I",
                text: "Drills make you break rock faster. Go to *Drills*, pick *Drill I* and hit *Buy*.",
                hint: () => global.shop.onPad
                    ? (global.shop.dismissed ? "Closed it? Step off the pad and back on." : "First tab. Drill V even stays when you die.")
                    : "Get back on the teal pad.",
                praise: "drill on",
                onEnter: () => { global.shop.dismissed = false; if (!global.shop.onPad) tut("goto", "shop"); },
                target: () => global.shop.onPad ? null : shopPad(),
                progress: () => global.shop.onPad ? 0.5 : 0.2,
                done: () => {
                    const d = shopState().drill | 0;
                    if (d < state.base.drill) state.base.drill = d;     // the reset landed late
                    return d > state.base.drill || d >= 5;
                },
                giveUp: 70000,
            },
            {
                id: "gear", allow: "shop:gear",
                title: "Gear",
                text: "Gear gives you a bonus for *5 minutes*, you can have 4 at once. Grab the *Gem Magnet* from the *Gear* tab, it pulls gems in from twice as far.",
                hint: () => global.shop.onPad ? "Gear tab, then Gem Magnet." : "Get back on the teal pad.",
                praise: "nice",
                onEnter: () => { global.shop.dismissed = false; if (!global.shop.onPad) tut("goto", "shop"); },
                target: () => global.shop.onPad ? null : shopPad(),
                progress: () => global.shop.onPad ? 0.5 : 0.2,
                done: () => {
                    const g = gearCount();
                    if (g < state.base.gear) state.base.gear = g;
                    return g > state.base.gear;
                },
                fallback: () => tut("gear", "magnet"),
                giveUp: 70000,
            },
            {
                id: "kit", allow: (sub) => sub === 0 ? "kit:medkit" : "kit:barrage", ui: "kit",
                // sub 0: Medkit.  sub 1: Rock Barrage at the dummy.
                title: () => state.sub === 0 ? "Kit items" : "Rock Barrage",
                text: () => {
                    if (state.sub === 0) return mob()
                        ? "Kit items are one-use things in your kit box. I took some of your health and gave you a *Medkit*. Tap it."
                        : `Kit items are one-use things in the box above your stats. I took some of your health and gave you a *Medkit*. Press ${kc(kitKeyFor("medkit"))}.`;
                    return mob()
                        ? "That's a *Rock Barrage*, 10 rocks that go through shields. Aim at the dummy and tap it."
                        : `That's a *Rock Barrage*, 10 rocks that go through shields. Aim at the dummy and press ${kc(kitKeyFor("barrage"))}.`;
                },
                hint: () => state.sub === 0
                    ? "It heals half your health and keeps the storm off you for 3 seconds."
                    : "You can hold 3 kinds of item. In a real raid you can drag one out of the box to throw it away.",
                praise: "nice",
                onEnter: () => {
                    global.shop.dismissed = true;
                    tut("goto", "clearing");
                    tut("kit", "medkit");
                    tut("hurt");
                    state.hurtAt = T();
                    state.kitPeak = 0;
                },
                target: () => {
                    if (state.sub === 0) return { kind: "self" };
                    const b = practiceBot("Dummy");
                    return b ? { kind: "foe", x: b.x, y: b.y } : null;
                },
                progress: () => state.sub === 0 ? 0 : 0.5,
                done: () => {
                    if (state.sub === 0) {
                        const n = kitCount("medkit");
                        state.kitPeak = Math.max(state.kitPeak, n);
                        // Regen would refill the bar and a Medkit at full is refused.
                        if (hpFrac(me()) > 0.6 && T() - state.hurtAt > 3000) { tut("hurt"); state.hurtAt = T(); }
                        if (state.kitPeak > 0 && n < state.kitPeak) {
                            setSub(1);
                            applyAllow(stepAllow(stepDef(), 1), stepDef().ui);
                            sfxAdvance();
                            tut("heal");
                            tut("kit", "barrage");
                            tut("dummy");
                            state.kitPeak = 0;
                        } else if (T() - state.stepAt > 4000 && state.kitPeak === 0) {
                            tut("kit", "medkit");
                            state.stepAt += 2000;
                        }
                        return false;
                    }
                    const n = kitCount("barrage");
                    state.kitPeak = Math.max(state.kitPeak, n);
                    if (state.kitPeak > 0 && n < state.kitPeak) return true;
                    // Kit full, so the barrage never landed: nothing to fire.
                    return T() - state.subAt > 4000 && state.kitPeak === 0;
                },
                settle: 600,
                fallback: () => { tut("heal"); },
                giveUp: 80000,
            },
            {
                id: "sidearm",
                title: "Sidearms",
                text: () => mob()
                    ? "Shops also sell *sidearms*, a second gun on the alt-fire button. Here's a *Drill Lance*, one shot breaks any rock. Try it."
                    : "Shops also sell *sidearms*, a second gun on [[Right click]]. Here's a *Drill Lance*, one shot breaks any rock. Try it.",
                hint: () => mob() ? "Hold the alt-fire button at some rock." : "Hold right click at some rock.",
                praise: "boom",
                onEnter: () => { tut("clear"); tut("arm", "lance"); },
                target: () => ({ kind: "self" }),
                progress: () => clamp(state.altMs / 1200, 0, 1),
                done: (p) => p >= 1,
                giveUp: 45000,
            },
        ],
    },

    // ── 6 ────────────────────────────────────────────────────────────
    {
        id: "loot", name: "Chests and bosses", mins: 1,
        blurb: "Where the big piles of gems come from.",
        prep: () => {
            tut("goto", "clearing");
            // Room in the satchel for the chest and boss loot.
            if ((global.gems.carried | 0) > 2500) tut("gems", 0);
        },
        steps: [
            {
                id: "chest",
                title: "Open a chest",
                text: "Every map has *6 chests*. Copper ones give *250* gems, epic ones give *500* plus a kit item. Shoot it open.",
                hint: "They break like rock, just tougher.",
                praise: "loot",
                onEnter: () => { state.askAt = T() + 700; },
                target: () => {
                    const c = nearestChest();
                    return c ? { kind: "foe", x: c.x, y: c.y, gold: true } : null;
                },
                progress: () => {
                    const c = nearestChest();
                    if (!c) return state.seen ? 1 : 0;
                    return clamp(1 - hpFrac(c), 0, 0.95);
                },
                done: () => {
                    const c = nearestChest();
                    if (c) state.seen = true;
                    if (!state.seen && T() > state.askAt) { tut("chest"); state.askAt = T() + 3500; }
                    return state.seen && !c;
                },
                settle: 500,
                fallback: () => tut("clear"),
                giveUp: 60000,
            },
            {
                id: "boss",
                title: "Boss",
                text: () => {
                    const b = bossEntity();
                    if (b && hpFrac(me()) < 0.45) return "Low? Back off and let your shield come back. It can't kill you here.";
                    return "Bosses dig out of the rock every 14 minutes or so. This practice *Vault Warden* only has a tenth of the health. Stay back and keep shooting.";
                },
                hint: "Circle it. Real ones usually take a few people.",
                praise: "boss down",
                onEnter: () => { tut("heal"); tut("goto", "clearing"); state.askAt = T() + 700; state.bossCarry = global.gems.carried | 0; },
                target: () => {
                    const b = bossEntity();
                    return b ? { kind: "foe", x: b.x, y: b.y, big: true } : null;
                },
                progress: () => {
                    const b = bossEntity();
                    if (!b) return state.seen ? 1 : 0;
                    return clamp(1 - hpFrac(b), 0, 0.97);
                },
                done: () => {
                    const b = bossEntity();
                    if (b) state.seen = true;
                    if (!state.seen && T() > state.askAt) { tut("boss", "warden"); state.askAt = T() + 3500; }
                    return state.seen && !b;
                },
                settle: 600,
                fallback: () => tut("bossclear"),
                giveUp: 130000,
            },
            {
                id: "bossLoot",
                title: "Grab the loot",
                text: "Bosses drop a ton of gems and an epic chest. Everyone gets a *BOSS DOWN* message, so in a real raid grab it fast.",
                hint: "Drive through the gems.",
                praise: "rich",
                target: () => {
                    const g = nearestGem();
                    return g ? { kind: "gem", x: g.x, y: g.y } : null;
                },
                // Loot grabbed while "Boss down" was still on the card counts.
                onEnter: () => {
                    if (state.bossCarry != null) state.base.carried = Math.min(state.base.carried, state.bossCarry);
                    state.bossCarry = null;
                },
                progress: () => clamp(((global.gems.carried | 0) - state.base.carried) / 400, 0, 1),
                done: (p) => {
                    if (p >= 1) return true;
                    // Satchel full: nothing more can be picked up.
                    if ((global.gems.carried | 0) >= ((global.gems.cap | 0) || 4000) - 10) return true;
                    // Nothing left on the ground (or it never dropped).
                    if (nearestGem()) state.flagAt = 0;
                    else if (!state.flagAt) state.flagAt = T();
                    return T() - state.stepAt > 1500 && state.flagAt > 0 && T() - state.flagAt > 2000;
                },
                giveUp: 40000,
            },
            {
                id: "events", next: true,
                title: "Events",
                text: "Each storm cycle can have an *ore bloom* (some rock turns rich for 100 seconds), a *meteor shower* or *gem rain*. They show on your map. Every cycle also has a *twist*, like giant tanks or double damage. That one shows on the left.",
                praise: "ok",
            },
        ],
    },

    // ── 7 ────────────────────────────────────────────────────────────
    {
        id: "raid", name: "The raid", mins: 1,
        blurb: "How a raid actually plays out.",
        steps: [
            {
                id: "storm",
                title: () => state.storm && state.storm.outside ? "Get inside" : "The storm",
                text: "The purple wall is the *storm*. You lose health fast out there. Get into the gold circle before the wall gets to you and stay in it.",
                hint: "The wall stops at the circle. Just get in and wait.",
                praise: "safe",
                onEnter: () => {
                    tut("heal");
                    startStormDrill();
                },
                target: () => state.storm ? { kind: "zone", x: state.storm.cx, y: state.storm.cy } : null,
                progress: () => state.storm ? clamp(state.storm.t, 0, 1) * 0.9 + (state.storm.safeSince ? 0.1 : 0) : 0,
                done: () => {
                    const d = state.storm;
                    return !!d && d.t >= 1 && !d.outside && d.safeSince > 0 && T() - d.safeSince > 1200;
                },
                onDone: () => { state.storm = null; },
                fallback: () => { state.storm = null; },
                giveUp: 70000,
            },
            {
                id: "raidClock", next: true,
                title: "How a raid works",
                text: "A raid is *2 hours* long. The storm shrinks for 6 minutes, holds for a minute, then opens up somewhere else. The last 45 seconds of each cycle is the *final storm*, nobody respawns during it.",
                praise: "ok",
            },
            {
                id: "dying", next: true,
                title: "Dying",
                text: "When you die you drop everything you're carrying. You come back in *15 seconds*, at your base if you have one, with a *4 second shield* that goes away when you move or shoot.",
                praise: "ok",
            },
            {
                id: "score", next: true,
                title: "Score",
                text: "Score is your banked gems, plus *200* per kill, plus half of what you're carrying. The *top 10* get bonus gems next raid. Get *4 kills* in a row and you show up on everyone's map, and whoever kills you gets a bounty. The quest card on the left pays gems for easy stuff.",
                praise: "ok",
            },
        ],
    },

    // ── 8 ────────────────────────────────────────────────────────────
    {
        id: "ranked", name: "Ranked", mins: 0.5,
        blurb: () => signedIn() ? "Ranks and gemdust." : "What you get for signing in.",
        steps: [
            {
                id: "rankedCard", next: true,
                title: () => signedIn() ? "Ranked" : "Play ranked",
                text: () => signedIn()
                    ? "You're signed in, so every raid is ranked, *Bronze* up to *Legend*. Your first *3 lives* are placement. You get *gemdust* from banking and kills (and chests, bosses, daily quests). Spend it in the *Item Shop*, then equip stuff in the *Locker*."
                    : "Sign in from the menu to play ranked and earn *gemdust* for cosmetics.",
                praise: "ok",
            },
        ],
    },

    // ── 9 ────────────────────────────────────────────────────────────
    {
        id: "final", name: "Final fight", mins: 1,
        blurb: "One quick 1v1 with a bot and you're done.",
        prep: () => { tut("kit", "medkit"); },
        steps: [
            {
                id: "fight", allow: "kit",
                title: "Beat the Rookie",
                text: () => {
                    if (!mob() && kitCount("medkit") > 0 && hpFrac(me()) < 0.45)
                        return `Low on health? ${kc(kitKeyFor("medkit"))} uses your Medkit.`;
                    return "Last one. Keep moving and keep shooting. It can't actually kill you.";
                },
                hint: () => mob()
                    ? "Circle around it so it misses."
                    : `Circle around it so it misses. ${kc("KEY_AUTO_FIRE")} is auto-fire.`,
                praise: "gg",
                onEnter: () => {
                    state.askAt = T() + 700;
                    global.shop.dismissed = true;
                    tut("goto", "clearing");
                },
                target: () => {
                    const b = practiceBot("Rookie");
                    return b ? { kind: "foe", x: b.x, y: b.y } : null;
                },
                progress: () => {
                    const b = practiceBot("Rookie");
                    if (!b) return state.seen ? 1 : 0;
                    return clamp(1 - hpFrac(b), 0, 1);
                },
                done: () => {
                    const b = practiceBot("Rookie");
                    if (b) state.seen = true;
                    if (!state.seen && T() > state.askAt) { tut("fighter"); state.askAt = T() + 3500; }
                    return state.seen && !b;
                },
                settle: 350,
                fallback: () => tut("clear"),
                giveUp: 120000,
            },
        ],
    },
];

// Flatten into one list; each step remembers its chapter.
let STEPS = [];
function buildSteps() {
    STEPS = [];
    CHAPTERS.forEach((ch, ci) => {
        ch.live = ch.steps.filter(s => !(s.omit && s.omit()));
        ch.live.forEach((s, si) => { s.ch = ci; s.si = si; STEPS.push(s); });
    });
}
const FINAL = () => STEPS.length;
function stepDef() { return STEPS[state.step]; }
function chapterOf(i) { const s = STEPS[i]; return s ? CHAPTERS[s.ch] : null; }
function firstStepOf(ci) { return STEPS.findIndex(s => s.ch === ci); }
function setSub(n) {
    state.sub = n;
    state.subAt = T();
    state.base.carried = global.gems.carried | 0;
    state.lastProgAt = T();
    state.hint = false;
}

// ── progress (resume) ──────────────────────────────────────────────────
function loadProgress() {
    try {
        const p = JSON.parse(localStorage.getItem(PROGRESS_KEY) || "null");
        if (p && typeof p === "object") {
            state.progress = {
                ch: clamp(p.ch | 0, 0, CHAPTERS.length - 1),
                done: Array.isArray(p.done) ? p.done.filter(x => typeof x === "string") : [],
            };
            return;
        }
    } catch (e) { }
    state.progress = { ch: 0, done: [] };
}
function saveProgress() {
    try { localStorage.setItem(PROGRESS_KEY, JSON.stringify(state.progress)); } catch (e) { }
}
function markChapterDone(ci) {
    const ch = CHAPTERS[ci];
    if (!ch) return;
    if (!state.progress.done.includes(ch.id)) state.progress.done.push(ch.id);
    state.progress.ch = Math.min(ci + 1, CHAPTERS.length - 1);
    saveProgress();
}

// ── step machine ───────────────────────────────────────────────────────
function applyAllow(allow, uiKind) {
    // Mirrored on window so the HUD hides controls the lesson has locked (see
    // drawSkillBars / drawKitBox in app.js). A step that says nothing is
    // locked down rather than inheriting the previous step's permissions.
    window.dwTutAllow = allow || "";
    window.dwTutUi = uiKind && uiKind.indexOf("stats:") === 0 ? "skills" : (uiKind || "");
    tut("allow", allow || "");
}

// What the server should permit for a step. Stat steps name their bars and
// how many points they want, and the server holds them to exactly that.
function stepAllow(s, sub) {
    if (s.stats) return "stats:" + s.stats.join(".") + ",budget:" + s.need;
    const a = typeof s.allow === "function" ? s.allow(sub | 0) : s.allow;
    return a || "";
}

// Everything a chapter needs, staged fresh, so any chapter can be the first.
function enterChapter(ci) {
    const ch = CHAPTERS[ci];
    if (!ch) return enterFinal();
    const first = firstStepOf(ci);
    if (first < 0) return enterChapter(ci + 1);
    state.progress.ch = ci;
    saveProgress();
    ui.menuResume = null;
    ui.hideMenu();
    tut("clear");
    tut("heal");
    tut("lock", "none");
    state.storm = null;
    state.mineCarry = null;
    state.bossCarry = null;
    state.lastBreak = null;
    if (global.showBigMap) global.showBigMap = false;
    if (ch.id !== "tank") {
        tut("untry");
        // Skipped the stat chapter? Play the rest on a built tank.
        if ((gui.points | 0) > 0) tut("spendrest");
    }
    if (ch.prep) { try { ch.prep(); } catch (e) { } }
    enterStep(first, true);
}

function enterStep(i, chapterStart) {
    if (i >= FINAL()) return enterFinal();
    const prev = stepDef();
    state.step = i;
    const s = stepDef();
    // Crossing into a new chapter by finishing the last one.
    if (!chapterStart && prev && prev.ch !== s.ch) return enterChapter(s.ch);
    state.stepAt = T();
    state.completedAt = 0;
    state.phase = "active";
    state.target = null;
    state.sub = 0;
    state.subAt = T();
    state.lastProg = 0;
    state.lastProgAt = T();
    state.hint = false;
    state.settleAt = 0;
    snapshot();
    applyAllow(stepAllow(s), s.ui);
    if (s.onEnter) { try { s.onEnter(); } catch (e) { } }
    ui.showStep(s, !!chapterStart);
    sfxAdvance();
}

function completeStep() {
    const s = stepDef();
    if (!s || state.phase !== "active") return;
    state.phase = "clearing";
    state.completedAt = T();
    if (s.onDone) { try { s.onDone(); } catch (e) { } }
    const lastInChapter = !STEPS[state.step + 1] || STEPS[state.step + 1].ch !== s.ch;
    if (lastInChapter) markChapterDone(s.ch);
    if (!s.next) {
        sfxObjective();
        const tg = state.target;
        if (tg && tg.kind !== "self" && tg.kind !== "pad" && tg.kind !== "zone") burst(tg.x, tg.y, tg.kind === "gem" ? EMERALD : GOLD);
        else burst(px(), py(), GOLD);
    } else sfxAdvance();
    ui.celebrate(s, lastInChapter);
}

// Stage the step's outcome ourselves, then count it done.
function stepFallback() {
    const s = stepDef();
    if (!s || state.phase !== "active") return;
    if (s.fallback) { try { s.fallback(); } catch (e) { } }
    completeStep();
}

function skipChapter() {
    const s = stepDef();
    if (!s || !state.running) return;
    if (s.fallback) { try { s.fallback(); } catch (e) { } }
    const ci = s.ch;
    enterChapter(ci + 1);
}

function enterFinal() {
    state.phase = "final";
    state.step = FINAL();
    state.target = null;
    state.storm = null;
    applyAllow("", "");
    tut("clear");
    tut("heal");
    tut("untry");
    // Count it as done the moment you see the send-off, even if the tab is
    // closed from here: they have seen the whole loop (or chose to skip it).
    try { localStorage.setItem(STORAGE_KEY, "1"); } catch (e) { }
    state.progress.ch = 0;
    saveProgress();
    ui.hideMenu();
    ui.showFinal();
    sfxFinale();
}

function openMenu() {
    if (!state.running) return;
    ui.showMenu(state.phase === "active" || state.phase === "clearing");
}

function burst(x, y, col) {
    for (let i = 0; i < 22; i++) {
        const a = Math.random() * Math.PI * 2;
        const sp = 60 + Math.random() * 200;
        state.bursts.push({
            x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
            rot: Math.random() * 6, vr: (Math.random() - 0.5) * 10,
            col: Math.random() < 0.3 ? "#fff3d9" : col,
            born: T(), life: 520 + Math.random() * 380,
        });
    }
}

const HINT_IDLE_MS = 10000;     // no progress this long: show the hint
const STUCK_MS = 22000;         // ...and this long: offer "skip this step"

let lastFrameAt = 0;
function update() {
    const now = T();
    const dt = Math.min(100, now - (lastFrameAt || now));
    lastFrameAt = now;
    // input bookkeeping, every frame
    if (state.fireDown) state.fireMs += dt;
    if (state.altDown || mobileAlt()) state.altMs += dt;
    if (gui.type !== state.lastType) {
        if (state.lastType !== null) state.evolveCount++;
        state.lastType = gui.type;
    }
    if (global.showBigMap) state.mapOpened = true;
    if (global.autoSpin) state.spinOn = true;
    if (state.storm && state.phase !== "menu") tickStormDrill(dt);

    const s = stepDef();
    if (!s || state.phase === "final" || state.phase === "menu") return;

    if (state.phase === "active") {
        state.target = s.target ? s.target() : null;
        if (s.next) { ui.tick(s, 0, false); return; }
        const p = s.progress ? clamp(s.progress(), 0, 1) : 0;
        if (p > state.lastProg + 0.015) { state.lastProg = p; state.lastProgAt = T(); state.hint = false; }
        let isDone = false;
        try { isDone = !!s.done(p); } catch (e) { }
        if (state.phase !== "active") return;        // done() may have fallen back
        if (isDone) {
            if (!s.settle) completeStep();
            else if (!state.settleAt) state.settleAt = T();
            else if (T() - state.settleAt > s.settle) completeStep();
        } else {
            state.settleAt = 0;
            const idle = T() - state.lastProgAt;
            if (!state.hint && idle > HINT_IDLE_MS) { state.hint = true; }
            if (T() - state.stepAt > (s.giveUp || 90000)) stepFallback();
        }
        if (state.phase === "active") ui.tick(s, p, T() - state.lastProgAt > STUCK_MS);
    } else if (state.phase === "clearing") {
        const lastInChapter = !STEPS[state.step + 1] || STEPS[state.step + 1].ch !== s.ch;
        if (T() - state.completedAt > (lastInChapter ? 1500 : s.next ? 350 : 1100)) enterStep(state.step + 1);
    }
}

// ── storm drill (client-side) ──────────────────────────────────────────
// A purple wall closes on a marked circle inside the clearing; the step clears
// once the learner is standing inside it when it stops. Nothing is hurt: the
// real storm is taught by the screen burning red while you stand outside.
function startStormDrill() {
    const tp = global.tutorialPlot || {};
    const cl = tp.clearing || tp.spawn || { x: px(), y: py() };
    let x = px(), y = py();
    if (Math.hypot(x - cl.x, y - cl.y) > 500) { tut("goto", "clearing"); x = cl.x; y = cl.y; }
    const ang = Math.atan2(y - cl.y, x - cl.x) + Math.PI;
    const off = Math.min(240, Math.max(0, (tp.clearingR || 540) - 290));
    const cx = cl.x + Math.cos(ang) * off, cy = cl.y + Math.sin(ang) * off;
    const dist = Math.hypot(x - cx, y - cy);
    const r0 = Math.max(1500, dist + 320);
    state.storm = { cx, cy, r0, r1: 260, startAt: T() + 1600, dur: 14000, t: 0, r: r0, outside: false, safeSince: 0 };
}
function tickStormDrill() {
    const d = state.storm;
    const now = T();
    d.t = clamp((now - d.startAt) / d.dur, 0, 1);
    d.r = lerp(d.r0, d.r1, smooth(d.t));
    const dist = Math.hypot(px() - d.cx, py() - d.cy);
    d.outside = now >= d.startAt && dist > d.r;
    if (d.t >= 1) {
        if (!d.outside) { if (!d.safeSince) d.safeSince = now; }
        else {
            d.safeSince = 0;
            // stood outside when it stopped: open it back up and go again
            if (now - d.startAt > d.dur + 2600) {
                d.startAt = now + 800;
                d.r0 = Math.max(1500, dist + 320);
                d.t = 0;
            }
        }
    }
}

// ── input ──────────────────────────────────────────────────────────────
// Toggles (auto-fire, auto-spin, override) are server-side with nothing
// mirrored on the client, so we watch the packets the game sends instead of
// guessing at keys: that covers remapped keys and the phone buttons alike.
function watchSocket() {
    const sock = global.canvas && global.canvas.socket;
    if (!sock || sock._tutWatched || typeof sock.talk !== "function") return;
    const orig = sock.talk;
    sock.talk = function (...a) {
        try {
            if (state.running && a[0] === "t") {
                if (a[1] === 1) state.toggles.fire++;
                else if (a[1] === 0) state.toggles.spin++;
                else if (a[1] === 2) state.toggles.override++;
            }
        } catch (e) { }
        return orig.apply(this, a);
    };
    sock._tutWatched = true;
}
function onMouseDown(e) {
    if (!state.running) return;
    if (e.target && e.target.closest && e.target.closest("#dwTut, #dwTutMenu, #dwTutEnd")) return;
    if (e.button === 0) state.fireDown = true;
    if (e.button === 2) state.altDown = true;
}
function onMouseUp(e) {
    if (e.button === 0) state.fireDown = false;
    if (e.button === 2) state.altDown = false;
}
// Phones: a finger on the right half of the screen is the aim-and-fire stick.
let rightTouches = 0;
function onTouch(e) {
    if (!state.running) return;
    let n = 0;
    for (const t of e.touches) if (t.clientX > window.innerWidth / 2) n++;
    rightTouches = n;
    state.fireDown = n > 0;
}
function mobileAlt() {
    return !!(global.mobile && global.clickables && global.clickables.mobileButtons && global.clickables.mobileButtons.altFire);
}
let listening = false;
function listen() {
    if (listening) return;
    listening = true;
    window.addEventListener("mousedown", onMouseDown, true);
    window.addEventListener("mouseup", onMouseUp, true);
    window.addEventListener("touchstart", onTouch, true);
    window.addEventListener("touchend", onTouch, true);
    window.addEventListener("touchcancel", onTouch, true);
    window.addEventListener("blur", () => { state.fireDown = false; state.altDown = false; });
}

// ── world pass ─────────────────────────────────────────────────────────
// Flat game-palette markers with thick ink outlines, like the HUD.
function inkStroke(c, width, color) {
    c.lineJoin = "round";
    c.lineCap = "round";
    c.lineWidth = width + 4;
    c.strokeStyle = INK;
    c.stroke();
    c.lineWidth = width;
    c.strokeStyle = color;
    c.stroke();
}

export function drawWorld(camX, camY, ratio) {
    const c = ctxWorld();
    state.edge = null;
    if (!c || !state.running) return;
    const now = T();

    if (state.storm) drawStormDrill(c, camX, camY, ratio);

    if (state.bursts.length) {
        c.save();
        for (let i = state.bursts.length - 1; i >= 0; i--) {
            const p = state.bursts[i];
            const t = (now - p.born) / p.life;
            if (t >= 1) { state.bursts.splice(i, 1); continue; }
            const e = 1 - Math.pow(1 - t, 2);
            const sp = w2s(p.x + p.vx * e, p.y + p.vy * e, camX, camY, ratio);
            const r = Math.max(2, (7 - 4 * t) * ratio);
            c.save();
            c.globalAlpha = 1 - t * t;
            c.translate(sp.x, sp.y);
            c.rotate(p.rot + p.vr * t);
            c.fillStyle = INK;
            c.fillRect(-r - 2, -r - 2, r * 2 + 4, r * 2 + 4);
            c.fillStyle = p.col;
            c.fillRect(-r, -r, r * 2, r * 2);
            c.restore();
        }
        c.restore();
    }

    if (state.phase !== "active" && state.phase !== "clearing") return;
    const tg = state.target;
    if (!tg) return;
    const fade = state.phase === "clearing" ? 1 - clamp((now - state.completedAt) / 380, 0, 1) : 1;
    if (fade <= 0) return;

    if (tg.kind === "self") { drawSelfRing(c, ratio, fade); return; }
    // A marked rock that has broken is not a target any more.
    if (tg.kind === "rock" && !rockAlive(terr(), tg.k)) return;

    const sp = w2s(tg.x, tg.y, camX, camY, ratio);
    const onScreen = sp.x > -40 && sp.x < SW() + 40 && sp.y > -40 && sp.y < SH() + 40;
    if (!onScreen) {
        // drawn in the late pass so no GUI covers it
        state.edge = { sp, tg, fade, at: now };
        return;
    }
    if (tg.kind === "zone") return;              // the drill draws its own circle
    c.save();
    c.globalAlpha = fade;
    let top = sp.y - 40;
    if (tg.kind === "rock") top = drawRockTarget(c, tg, camX, camY, ratio);
    else if (tg.kind === "pad") top = drawPadTarget(c, tg, sp, ratio);
    else top = drawPointTarget(c, tg, sp, ratio);
    drawPointer(c, sp.x, top - 14);
    c.restore();
    drawTrail(c, sp, fade, tg.kind === "foe" && !tg.gold ? FOE : GOLD);
}

function drawSelfRing(c, ratio, fade) {
    const s = stepDef();
    let pr = 1;
    if (s && !s.next && s.progress && state.phase === "active") pr = clamp(s.progress(), 0, 1);
    const cx = SW() / 2, cy = SH() / 2;
    const R = 62 * ratio;
    c.save();
    c.globalAlpha = fade;
    c.beginPath(); c.arc(cx, cy, R, 0, Math.PI * 2);
    c.lineWidth = 9; c.strokeStyle = "rgba(12,10,14,.45)"; c.stroke();
    if (pr > 0.01) {
        c.beginPath();
        c.arc(cx, cy, R, -Math.PI / 2, -Math.PI / 2 + pr * Math.PI * 2);
        inkStroke(c, 5, GOLD);
    }
    c.restore();
}

// The marked rock: its real silhouette, a soft gold fill, a marching outline.
function drawRockTarget(c, tg, camX, camY, ratio) {
    const t = terr();
    const now = T();
    const center = w2s(tg.x, tg.y, camX, camY, ratio);
    let minY = center.y - 30;
    const cell = t && t._cellPolys.get(tg.k);
    if (cell && cell.poly && cell.poly.length > 2 && rockAlive(t, tg.k)) {
        const w = t._world;
        c.beginPath();
        minY = Infinity;
        for (let i = 0; i < cell.poly.length; i++) {
            const p = w2s(cell.poly[i][0] * w.s - w.hw, cell.poly[i][1] * w.s - w.hh, camX, camY, ratio);
            if (i === 0) c.moveTo(p.x, p.y); else c.lineTo(p.x, p.y);
            minY = Math.min(minY, p.y);
        }
        c.closePath();
        const pulse = 0.5 + 0.5 * Math.sin(now / 280);
        c.save();
        c.fillStyle = `rgba(${GOLD_RGB},${0.16 + 0.12 * pulse})`;
        c.fill();
        c.setLineDash([12, 8]);
        c.lineDashOffset = -now / 30;
        inkStroke(c, 3.5, GOLD);
        c.restore();
    }
    return minY;
}

// Vault / shop / base pad: a slow rotating dashed ring sized to the pad.
function drawPadTarget(c, tg, sp, ratio) {
    const now = T();
    const R = Math.max(40, (tg.r || 95) * ratio * 1.15) + 4 * Math.sin(now / 320);
    c.beginPath(); c.arc(sp.x, sp.y, R, 0, Math.PI * 2);
    c.save();
    c.setLineDash([16, 12]);
    c.lineDashOffset = -now / 26;
    inkStroke(c, 4, GOLD);
    c.restore();
    return sp.y - R;
}

// Gems, bots, chests, bosses: two expanding ripples in the target's colour.
function drawPointTarget(c, tg, sp, ratio) {
    const now = T();
    const col = tg.kind === "foe" ? (tg.gold ? GOLD : FOE) : EMERALD;
    const base = (tg.kind === "foe" ? (tg.big ? 90 : 44) : 20) * Math.max(0.6, ratio);
    for (let i = 0; i < 2; i++) {
        const t = ((now / 1000) + i * 0.5) % 1;
        c.save();
        c.globalAlpha *= (1 - t) * (tg.ghost ? 0.5 : 1);
        c.beginPath(); c.arc(sp.x, sp.y, base + t * base * 1.6, 0, Math.PI * 2);
        inkStroke(c, 3, col);
        c.restore();
    }
    return sp.y - base * 1.2;
}

// Chunky bouncing arrow above the target.
function drawPointer(c, x, y) {
    const bob = Math.sin(T() / 240) * 6;
    c.save();
    c.translate(x, y - 8 + bob);
    c.beginPath();
    c.moveTo(0, 14); c.lineTo(15, -4); c.lineTo(6, -4); c.lineTo(6, -18);
    c.lineTo(-6, -18); c.lineTo(-6, -4); c.lineTo(-15, -4);
    c.closePath();
    c.lineJoin = "round";
    c.lineWidth = 7; c.strokeStyle = INK; c.stroke();
    c.fillStyle = GOLD; c.fill();
    c.beginPath(); c.moveTo(-3, -15); c.lineTo(-3, -6);
    c.lineWidth = 2.5; c.strokeStyle = "rgba(255,255,255,.55)"; c.stroke();
    c.restore();
}

// A few chevrons marching from your tank toward the target.
function drawTrail(c, sp, fade, col) {
    const ox = SW() / 2, oy = SH() / 2;
    const dx = sp.x - ox, dy = sp.y - oy, dist = Math.hypot(dx, dy);
    if (dist < 170) return;
    const ang = Math.atan2(dy, dx);
    const n = Math.min(3, Math.floor(dist / 110));
    const now = T();
    c.save();
    for (let i = 0; i < n; i++) {
        const t = ((now / 1200) + i / n) % 1;
        const d = 80 + t * Math.min(dist - 130, n * 110);
        c.save();
        c.globalAlpha = Math.sin(t * Math.PI) * 0.85 * fade;
        c.translate(ox + Math.cos(ang) * d, oy + Math.sin(ang) * d);
        c.rotate(ang);
        c.beginPath(); c.moveTo(-9, -12); c.lineTo(7, 0); c.lineTo(-9, 12);
        inkStroke(c, 5, col);
        c.restore();
    }
    c.restore();
}

// The storm drill: a purple wall closing on a gold safe circle, everything
// outside it dimmed like the real storm.
function drawStormDrill(c, camX, camY, ratio) {
    const d = state.storm;
    const now = T();
    const sp = w2s(d.cx, d.cy, camX, camY, ratio);
    const rr = Math.max(0, d.r * ratio);
    c.save();
    c.beginPath();
    c.rect(-40, -40, SW() + 80, SH() + 80);
    c.arc(sp.x, sp.y, rr, 0, Math.PI * 2, true);
    c.fillStyle = "rgba(72, 38, 96, 0.46)";
    c.fill("evenodd");
    const wall = Math.max(8, 12 * ratio);
    c.beginPath();
    c.arc(sp.x, sp.y, rr + wall, 0, Math.PI * 2);
    c.arc(sp.x, sp.y, Math.max(0, rr - 2), 0, Math.PI * 2, true);
    c.fillStyle = "#6a3a78";
    c.fill("evenodd");
    c.beginPath(); c.arc(sp.x, sp.y, rr, 0, Math.PI * 2);
    c.lineWidth = Math.max(2, 2.5 * ratio); c.strokeStyle = "#2a1028"; c.stroke();
    // the safe circle: where the wall will stop
    const zr = d.r1 * ratio;
    c.globalAlpha = 0.12;
    c.fillStyle = GOLD;
    c.beginPath(); c.arc(sp.x, sp.y, zr, 0, Math.PI * 2); c.fill();
    c.globalAlpha = 1;
    c.setLineDash([14, 10]);
    c.lineDashOffset = -now / 30;
    c.beginPath(); c.arc(sp.x, sp.y, zr, 0, Math.PI * 2);
    inkStroke(c, 3.5, GOLD);
    c.setLineDash([]);
    c.restore();
    if (sp.x > 0 && sp.x < SW() && sp.y - zr > 20) drawPointer(c, sp.x, sp.y - zr - 14);
}

// Red edges and a line of text while the learner stands in the drill's storm.
function drawStormDrillHud(c) {
    const d = state.storm;
    if (!d || !d.outside) return;
    const S = US();
    const cx = SW() / 2, cy = SH() / 2;
    const pulse = 0.5 + 0.5 * Math.sin(T() / 130);
    c.save();
    const g = c.createRadialGradient(cx, cy, Math.min(SW(), SH()) * 0.28, cx, cy, Math.max(SW(), SH()) * 0.72);
    g.addColorStop(0, "rgba(140,30,50,0)");
    g.addColorStop(1, `rgba(140,30,50,${0.42 + 0.18 * pulse})`);
    c.fillStyle = g;
    c.fillRect(0, 0, SW(), SH());
    c.font = `400 ${20 * S}px ${DISPLAY}`;
    c.textAlign = "center";
    c.textBaseline = "middle";
    c.lineJoin = "round";
    c.lineWidth = 6 * S;
    c.strokeStyle = INK;
    c.strokeText("You're in the storm, get inside", cx, SH() * 0.7);
    c.fillStyle = "#ffb0a4";
    c.fillText("You're in the storm, get inside", cx, SH() * 0.7);
    c.restore();
}

// Off-screen target: a chunky arrow pinned to the screen edge, pointing at
// it, with the distance on an ink pill.
function drawEdgeArrow(e) {
    const c = ctxGui();
    if (!c) return;
    const S = US();
    const cx = SW() / 2, cy = SH() / 2;
    const ang = Math.atan2(e.sp.y - cy, e.sp.x - cx);
    const inset = 44 * S;
    const t = Math.min((cx - inset) / (Math.abs(Math.cos(ang)) || 1e-9),
                       (cy - inset) / (Math.abs(Math.sin(ang)) || 1e-9));
    const ax = cx + Math.cos(ang) * t, ay = cy + Math.sin(ang) * t;
    const pulse = 1 + 0.07 * Math.sin(T() / 240);
    const col = e.tg.kind === "foe" && !e.tg.gold ? FOE : GOLD;
    c.save();
    c.globalAlpha = e.fade;
    c.translate(ax, ay);
    c.save();
    c.rotate(ang);
    c.scale(pulse * S, pulse * S);
    c.beginPath();
    c.moveTo(20, 0); c.lineTo(-8, -16); c.lineTo(-2, 0); c.lineTo(-8, 16);
    c.closePath();
    c.lineJoin = "round";
    c.lineWidth = 7; c.strokeStyle = INK; c.stroke();
    c.fillStyle = col; c.fill();
    c.restore();
    const txt = Math.max(1, Math.round(distTo(e.tg) / 10)) + "m";
    c.font = `400 ${14 * S}px ${DISPLAY}`;
    c.textAlign = "center";
    c.textBaseline = "middle";
    const tx = -Math.cos(ang) * 38 * S, ty = -Math.sin(ang) * 38 * S;
    const w = c.measureText(txt).width + 14 * S, h = 20 * S;
    c.beginPath();
    if (c.roundRect) c.roundRect(tx - w / 2, ty - h / 2, w, h, h / 2);
    else c.rect(tx - w / 2, ty - h / 2, w, h);
    c.fillStyle = INK; c.fill();
    c.fillStyle = "#fff3d9";
    c.fillText(txt, tx, ty + 1 * S);
    c.restore();
}

// ── HUD highlight ──────────────────────────────────────────────────────
// Built from the game's own clickable regions, which app.js registers in
// *clickable* space (x * clickableRatio), so divide that back out. Recomputed
// every frame: it stays glued to the widget across resizes and UI Scale.
function uiRect(kind) {
    const cl = global.clickables;
    if (!cl || !kind) return null;
    const cr = (global.canvas && global.canvas.height && SH() && global.ratio)
        ? global.canvas.height / SH() / global.ratio : 1;
    if (!cr || !isFinite(cr)) return null;
    const pad = 8 * US();
    const rs = [];
    try {
        if (kind.indexOf("stats:") === 0) {
            for (const i of kind.slice(6).split(",")) rs.push(cl.stat.rect(parseInt(i, 10)));
        } else if (kind === "skills") {
            for (let i = 0; i < cl.stat.size(); i++) rs.push(cl.stat.rect(i));
        } else if (kind === "kit" && cl.kit) {
            for (let i = 0; i < 3; i++) rs.push(cl.kit.rect(i));
        } else if (kind === "upgrades") {
            const n = (gui.upgrades || []).length;
            for (let i = 0; i < n; i++) rs.push(cl.upgrade.rect(i));
        }
    } catch (e) { return null; }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, any = false;
    for (const r of rs) {
        if (!r || !(r.w > 0) || !(r.h > 0)) continue;
        any = true;
        x0 = Math.min(x0, r.x / cr); y0 = Math.min(y0, r.y / cr);
        x1 = Math.max(x1, (r.x + r.w) / cr); y1 = Math.max(y1, (r.y + r.h) / cr);
    }
    if (!any) return null;
    const m = 2;
    const bx0 = Math.max(x0 - pad, m), by0 = Math.max(y0 - pad, m);
    const bx1 = Math.min(x1 + pad, SW() - m), by1 = Math.min(y1 + pad, SH() - m);
    if (bx1 <= bx0 || by1 <= by0) return null;
    return { x: bx0, y: by0, w: bx1 - bx0, h: by1 - by0 };
}
function drawUiHighlight(c, kind) {
    const box = uiRect(kind);
    if (!box) return;
    const S = US();
    const now = T();
    const r = 9 * S;
    c.save();
    c.beginPath();
    if (c.roundRect) c.roundRect(box.x, box.y, box.w, box.h, r); else c.rect(box.x, box.y, box.w, box.h);
    c.setLineDash([12 * S, 8 * S]);
    c.lineDashOffset = -now / 30;
    inkStroke(c, 3.5 * S, GOLD);
    c.restore();
    // a little bobbing arrow on the side facing the middle of the screen
    const left = box.x + box.w / 2 < SW() / 2;
    const top = box.y + box.h / 2 < SH() / 2;
    const bob = Math.sin(now / 240) * 6;
    c.save();
    if (top) { c.translate(box.x + box.w / 2, box.y + box.h + 30 * S + bob); c.rotate(Math.PI); }
    else if (left) { c.translate(box.x + box.w + 30 * S + bob, box.y + box.h / 2); c.rotate(Math.PI / 2); }
    else { c.translate(box.x - 30 * S - bob, box.y + box.h / 2); c.rotate(-Math.PI / 2); }
    c.scale(S, S);
    c.beginPath();
    c.moveTo(0, 14); c.lineTo(15, -4); c.lineTo(6, -4); c.lineTo(6, -18);
    c.lineTo(-6, -18); c.lineTo(-6, -4); c.lineTo(-15, -4);
    c.closePath();
    c.lineJoin = "round";
    c.lineWidth = 7; c.strokeStyle = INK; c.stroke();
    c.fillStyle = GOLD; c.fill();
    c.restore();
}

// Drawn from the very end of the frame so no GUI element can cover it.
export function drawIndicators() {
    if (!state.running || global.died || global.disconnected) return;
    const c = ctxGui();
    if (!c) return;
    if (state.storm) drawStormDrillHud(c);
    const s = stepDef();
    if (s && s.ui && state.phase === "active") drawUiHighlight(c, s.ui);
    const e = state.edge;
    if (!e || T() - e.at > 250) return;
    drawEdgeArrow(e);
}

// ── the card (DOM) ─────────────────────────────────────────────────────
function esc(s) {
    return String(s).replace(/[&<>"]/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
}
function markup(str) {
    let out = esc(str || "");
    out = out.replace(/\{\{(KEY_[A-Z0-9_]+)\}\}/g, (m, id) => `<kbd>${esc(lbl(id))}</kbd>`);
    out = out.replace(/\[\[([^\]]+)\]\]/g, (m, k) => `<kbd>${k}</kbd>`);
    out = out.replace(/\*([^*]+)\*/g, "<b>$1</b>");
    return out;
}
const val = (v) => typeof v === "function" ? v() : v;
// Display name of a tank type ("12" or split "12-40"), or "" if unknown.
function tankName(type = gui.type) {
    try {
        const m = global.mockups[parseInt(String(type).split("-")[0])];
        return (m && m.name) || "";
    } catch (e) { return ""; }
}

const ICONS = {
    storm: '<svg viewBox="0 0 40 40"><circle cx="20" cy="20" r="15" fill="#9b78e0" stroke="#0c0a0e" stroke-width="3.5"/><circle cx="20" cy="20" r="7" fill="#2b2533" stroke="#0c0a0e" stroke-width="3"/><path d="M8 13 A15 15 0 0 1 27 6" fill="none" stroke="#e5d8ff" stroke-width="3" stroke-linecap="round"/></svg>',
    gem: '<svg viewBox="0 0 40 40"><path d="M11 6h18l7 9-16 20L4 15z" fill="#3fcf7a" stroke="#0c0a0e" stroke-width="3.5" stroke-linejoin="round"/><path d="M4 15h32M15 6l5 29M25 6l-5 29" fill="none" stroke="#1d7a44" stroke-width="2"/><path d="M13 9l-4 5" stroke="#d7ffe6" stroke-width="3" stroke-linecap="round"/></svg>',
    crown: '<svg viewBox="0 0 40 40"><path d="M5 30 3 11l10 8 7-12 7 12 10-8-2 19z" fill="#f2b83c" stroke="#0c0a0e" stroke-width="3.5" stroke-linejoin="round"/><rect x="5" y="30" width="30" height="5" rx="1.5" fill="#a8750f" stroke="#0c0a0e" stroke-width="3"/></svg>',
    base: '<svg viewBox="0 0 40 40"><path d="M14 4h12l10 10v12L26 36H14L4 26V14z" fill="#e8a05c" stroke="#0c0a0e" stroke-width="3.5" stroke-linejoin="round"/><rect x="14" y="14" width="12" height="12" rx="2" fill="#6a6f7a" stroke="#0c0a0e" stroke-width="3"/></svg>',
};

// Ore tiers for the "Four kinds of ore" card: the game's own baked gem
// sprites (window.dwDrawGem, app.js) at a fixed pixel size.
const ORES = [
    { cls: "gemPickupCopper", name: "Copper", val: "15", col: "#c96f2e" },
    { cls: "gemPickupVein", name: "Azurite", val: "30", col: "#3b7ce0" },
    { cls: "gemPickupShard", name: "Core Shard", val: "150", col: "#b13ecf" },
    { cls: "gemPickupEmerald", name: "Emerald", val: "500", col: "#1fbf6b" },
];
function extraHtml(kind) {
    if (kind === "ores") {
        return '<div class="dwt-ores">' + ORES.map((o, i) =>
            `<div class="dwt-ore"><canvas data-ore="${i}"></canvas><span class="dwt-ore-name">${o.name}</span><span class="dwt-ore-val">${o.val}</span></div>`
        ).join("") + "</div>";
    }
    if (kind === "keys") {
        const rows = [
            [kc("KEY_TOGGLE_MAP"), "big map"],
            [kc("KEY_CLASS_TREE"), "upgrade tree"],
            [kc("KEY_OVER_RIDE"), "drones go to your mouse"],
            [`${kc("KEY_KIT_1")} ${kc("KEY_KIT_2")} ${kc("KEY_KIT_3")}`, "kit items"],
            ["[[Right click]]", "sidearm"],
            [`${kc("KEY_MAX_STAT")} + stat key`, "max a stat"],
            [kc("KEY_CHAT"), "chat"],
        ];
        return '<div class="dwt-keys">' + rows.map(r =>
            `<div class="dwt-key"><span class="dwt-key-caps">${markup(r[0])}</span><span>${esc(r[1])}</span></div>`).join("") + "</div>";
    }
    return "";
}
function paintExtra(root) {
    for (const cv of root.querySelectorAll("canvas[data-ore]")) {
        const o = ORES[+cv.dataset.ore];
        const dpr = window.devicePixelRatio || 1;
        const size = cv.clientWidth || 44;
        cv.width = Math.round(size * dpr); cv.height = Math.round(size * dpr);
        const c = cv.getContext("2d");
        c.setTransform(dpr, 0, 0, dpr, 0, 0);
        c.clearRect(0, 0, size, size);
        try {
            if (typeof window.dwDrawGem === "function") { window.dwDrawGem(c, size / 2, size / 2, size * 0.36, 1, -0.35, o.cls); continue; }
        } catch (e) { }
        // fallback: a flat cut gem in the ore's colour
        const r = size * 0.34;
        c.beginPath();
        c.moveTo(size / 2 - r * 0.6, size / 2 - r * 0.7); c.lineTo(size / 2 + r * 0.6, size / 2 - r * 0.7);
        c.lineTo(size / 2 + r, size / 2 - r * 0.15); c.lineTo(size / 2, size / 2 + r); c.lineTo(size / 2 - r, size / 2 - r * 0.15);
        c.closePath();
        c.fillStyle = o.col; c.fill();
        c.lineJoin = "round"; c.lineWidth = 3; c.strokeStyle = INK; c.stroke();
    }
}

function injectStyles() {
    if (document.getElementById("dwTutCss")) return;
    try {
        const l = document.createElement("link");
        l.id = "dwTutCss";
        l.rel = "stylesheet";
        l.href = new URL("../tutorial.css", import.meta.url).href;
        document.head.appendChild(l);
    } catch (e) { }
}

const ui = {
    root: null, card: null, eyebrow: null, dots: null, title: null, text: null, extra: null,
    bar: null, fill: null, hint: null, hintText: null, stuckBtn: null, stamp: null, nextBtn: null,
    menuWrap: null, endWrap: null,
    last: {},
    build() {
        if (this.root) return;
        injectStyles();
        const root = document.createElement("div");
        root.id = "dwTut";
        root.innerHTML =
            '<div class="dwt-card">' +
              '<div class="dwt-top">' +
                '<span class="dwt-eyebrow"></span>' +
                '<span class="dwt-dots"></span>' +
                '<button class="dwt-skip dwt-chapters" type="button">Chapters</button>' +
                '<button class="dwt-skip dwt-skipch" type="button">Skip chapter</button>' +
              '</div>' +
              '<div class="dwt-title"></div>' +
              '<div class="dwt-text"></div>' +
              '<div class="dwt-extra"></div>' +
              '<div class="dwt-bar"><i></i></div>' +
              '<button class="dwt-next" type="button">Got it</button>' +
              '<div class="dwt-hint"><span class="dwt-tip">Tip</span><span class="dwt-hint-text"></span>' +
                '<button class="dwt-stuck" type="button">Skip this step</button></div>' +
              '<div class="dwt-stamp"></div>' +
            '</div>';
        document.body.appendChild(root);
        this.root = root;
        this.card = root.querySelector(".dwt-card");
        this.eyebrow = root.querySelector(".dwt-eyebrow");
        this.dots = root.querySelector(".dwt-dots");
        this.title = root.querySelector(".dwt-title");
        this.text = root.querySelector(".dwt-text");
        this.extra = root.querySelector(".dwt-extra");
        this.bar = root.querySelector(".dwt-bar");
        this.fill = root.querySelector(".dwt-bar i");
        this.nextBtn = root.querySelector(".dwt-next");
        this.hint = root.querySelector(".dwt-hint");
        this.hintText = root.querySelector(".dwt-hint-text");
        this.stuckBtn = root.querySelector(".dwt-stuck");
        this.stamp = root.querySelector(".dwt-stamp");
        const guard = (b, fn) => {
            b.tabIndex = -1;
            b.addEventListener("mousedown", e => e.preventDefault());
            b.addEventListener("click", e => { e.stopPropagation(); fn(); handBackFocus(); });
        };
        guard(root.querySelector(".dwt-chapters"), () => openMenu());
        guard(root.querySelector(".dwt-skipch"), () => skipChapter());
        guard(this.stuckBtn, () => stepFallback());
        guard(this.nextBtn, () => { if (state.phase === "active" && stepDef() && stepDef().next) completeStep(); });

        // The chapter list: shown first, and from the Chapters button.
        const menu = document.createElement("div");
        menu.id = "dwTutMenu";
        menu.innerHTML =
            '<div class="dwt-end-card dwt-menu-card">' +
              '<div class="dwt-end-badge">Tutorial</div>' +
              '<div class="dwt-end-title">How to play</div>' +
              '<div class="dwt-end-sub"></div>' +
              '<ol class="dwt-ch-list"></ol>' +
              '<button class="dwt-play dwt-go" type="button"><b>Start</b></button>' +
              '<button class="dwt-menu dwt-alt" type="button">Skip tutorial</button>' +
            '</div>';
        document.body.appendChild(menu);
        this.menuWrap = menu;
        const list = menu.querySelector(".dwt-ch-list");
        CHAPTERS.forEach((ch, ci) => {
            const li = document.createElement("li");
            li.innerHTML = `<button type="button" data-ch="${ci}"><span class="dwt-ch-num">${ci + 1}</span>` +
                `<span class="dwt-ch-body"><span class="dwt-ch-name">${esc(ch.name)}</span><span class="dwt-ch-blurb"></span></span>` +
                `<span class="dwt-ch-meta"></span></button>`;
            list.appendChild(li);
            li.querySelector("button").addEventListener("click", (e) => { e.stopPropagation(); enterChapter(ci); handBackFocus(); });
        });
        menu.querySelector(".dwt-go").addEventListener("click", (e) => {
            e.stopPropagation();
            if (this.menuResume) {
                // The step was paused while the list was up: push its clocks
                // on by the pause, or the hint, the skip link and the
                // give-up fallback would all fire the moment it resumes.
                const paused = T() - (this.menuAt || T());
                state.stepAt += paused; state.subAt += paused; state.lastProgAt += paused;
                if (state.settleAt) state.settleAt += paused;
                if (state.completedAt) state.completedAt += paused;
                if (state.askAt) state.askAt += paused;
                if (state.storm) state.storm.startAt += paused;
                this.hideMenu(); state.phase = this.menuResume; this.menuResume = null;
            }
            else enterChapter(state.progress.ch | 0);
            handBackFocus();
        });
        menu.querySelector(".dwt-alt").addEventListener("click", (e) => { e.stopPropagation(); enterFinal(); handBackFocus(); });

        const end = document.createElement("div");
        end.id = "dwTutEnd";
        end.innerHTML =
            '<div class="dwt-end-card">' +
              '<div class="dwt-end-badge">Tutorial done</div>' +
              '<div class="dwt-end-title">You\'re ready</div>' +
              '<div class="dwt-end-sub">Quick recap:</div>' +
              '<ul class="dwt-end-list">' +
                `<li>${ICONS.gem}<span><b>Mine</b> and <b>bank a lot</b>. You drop what you're carrying when you die.</span></li>` +
                `<li>${ICONS.base}<span>Get a <b>base</b> so you respawn close and can bank on the way. Spend gems at <b>shops</b>.</span></li>` +
                `<li>${ICONS.storm}<span>Stay inside the <b>storm</b>. Chests and bosses pay the most.</span></li>` +
                `<li>${ICONS.crown}<span>Highest score after <b>2 hours</b> wins. Top 10 all get paid.</span></li>` +
              '</ul>' +
              '<button class="dwt-play" type="button"><b>Play</b></button>' +
              '<button class="dwt-menu dwt-back" type="button">Back to menu</button>' +
              '<button class="dwt-replay" type="button">Chapters</button>' +
              '<div class="dwt-end-foot"></div>' +
            '</div>';
        document.body.appendChild(end);
        this.endWrap = end;
        end.querySelector(".dwt-play").addEventListener("click", () => finish(true));
        end.querySelector(".dwt-back").addEventListener("click", () => finish(false));
        end.querySelector(".dwt-replay").addEventListener("click", (e) => {
            e.stopPropagation();
            end.classList.remove("show");
            ui.showMenu(false);
        });
    },
    // Size in lockstep with the game's UI Scale setting, and never wider or
    // taller than a phone can afford.
    layout() {
        const scale = { 2560: 0.9, 1920: 1, 1536: 1.12, 1280: 1.05 }[global.UIscale] || 1;
        const vw = window.innerWidth, vh = window.innerHeight;
        const short = vh < 480;
        const fit = Math.min(1, vw / 640, vh / (short ? 600 : 560));
        const s = clamp(scale * fit, 0.58, 1.25);
        const compact = !!(global.shop && global.shop.onPad && !global.shop.dismissed);
        // Runs every frame: only touch the DOM when something changed. A
        // custom property written on <html> every frame restyles the whole
        // page every frame, even when the value is the same.
        const key = s.toFixed(3) + (short ? "s" : "") + (global.mobile ? "m" : "") + (compact ? "c" : "");
        if (key === this._layoutKey) return;
        this._layoutKey = key;
        this.root.classList.toggle("short", short);
        document.documentElement.style.setProperty("--dwt-s", s.toFixed(3));
        this.root.classList.toggle("mobile", !!global.mobile);
        // The shop panel opens over the middle of the screen with its header
        // near the top: shrink to one line so it never sits on the tabs.
        this.root.classList.toggle("compact", compact);
    },
    showStep(s, chapterStart) {
        this.build();
        this.last = {};
        const ch = CHAPTERS[s.ch];
        this.card.classList.remove("done", "enter", "chapter", "info");
        void this.card.offsetWidth;          // restart the entrance animation
        this.card.classList.add("enter");
        if (chapterStart) this.card.classList.add("chapter");
        this.card.classList.toggle("info", !!s.next);
        this.root.classList.add("show");
        this.eyebrow.textContent = `Chapter ${s.ch + 1} · ${ch.name}`;
        this.dots.innerHTML = "";
        if (ch.live.length > 1) {
            for (let k = 0; k < ch.live.length; k++) {
                const d = document.createElement("i");
                d.className = k < s.si ? "on" : k === s.si ? "cur" : "";
                this.dots.appendChild(d);
            }
        }
        this.stamp.textContent = "";
        this.hint.classList.remove("show", "stuck");
        this.card.classList.remove("hinting");
        this.fill.style.width = "0%";
        this.extra.innerHTML = s.extra ? extraHtml(s.extra) : "";
        this.extra.style.display = s.extra ? "" : "none";
        if (s.extra) paintExtra(this.extra);
        this.nextBtn.textContent = s.nextLabel || "Got it";
        this.render(s);
        this.layout();
    },
    render(s) {
        const t = val(s.title), x = val(s.text);
        if (t !== this.last.t) { this.title.textContent = t; this.last.t = t; }
        if (x !== this.last.x) { this.text.innerHTML = markup(x); this.last.x = x; }
    },
    tick(s, p, stuck) {
        this.layout();
        this.render(s);
        if (s.next) return;
        const w = Math.round(p * 100) + "%";
        if (this.last.w !== w) { this.fill.style.width = w; this.last.w = w; }
        if (state.hint) {
            const h = val(s.hint) || "";
            if (h !== this.last.h) { this.hintText.innerHTML = markup(h); this.last.h = h; }
        }
        const hs = (state.hint ? "h" : "") + (stuck ? "s" : "");
        if (hs !== this.last.hs) {
            this.last.hs = hs;
            this.hint.classList.toggle("show", !!state.hint);
            this.card.classList.toggle("hinting", !!state.hint);
            this.hint.classList.toggle("stuck", !!stuck);
        }
    },
    celebrate(s, lastInChapter) {
        this.card.classList.add("done");
        this.fill.style.width = "100%";
        this.hint.classList.remove("show");
        this.card.classList.remove("hinting");
        if (!s.next || lastInChapter) this.stamp.textContent = lastInChapter ? "chapter done" : (val(s.praise) || "nice");
        const d = this.dots.children[s.si];
        if (d) d.className = "on pop";
    },
    menuResume: null,
    showMenu(midway) {
        this.build();
        this.layout();
        // Opened from the card: the game keeps running behind it, the step
        // just pauses (update() ignores the "menu" phase).
        this.menuResume = midway ? state.phase : null;
        this.menuAt = T();
        if (midway) state.phase = "menu";
        const done = new Set(state.progress.done);
        const cur = midway && stepDef() ? stepDef().ch : (state.progress.ch | 0);
        const btns = this.menuWrap.querySelectorAll(".dwt-ch-list button");
        btns.forEach((b, ci) => {
            const ch = CHAPTERS[ci];
            b.classList.toggle("done", done.has(ch.id));
            b.classList.toggle("cur", ci === cur);
            b.querySelector(".dwt-ch-blurb").textContent = val(ch.blurb);
            b.querySelector(".dwt-ch-meta").textContent = done.has(ch.id) ? "Done" : (ch.mins < 1 ? "30 sec" : ch.mins + " min");
        });
        const total = Math.round(CHAPTERS.reduce((a, c) => a + c.mins, 0));
        const fresh = !state.progress.done.length && !(state.progress.ch | 0);
        const allDone = CHAPTERS.every(c => done.has(c.id));
        this.menuWrap.querySelector(".dwt-end-sub").textContent = midway
            ? "Jump to any chapter, or keep going."
            : fresh ? `${CHAPTERS.length} short chapters, about ${total} minutes. Tap one to jump in.`
            : allDone ? "You've done them all. Redo any you want."
            : "Welcome back. Keep going or pick a chapter.";
        const go = this.menuWrap.querySelector(".dwt-go b");
        go.textContent = midway ? "Keep going" : fresh ? "Start" : allDone ? "Start over" : `Continue: ${CHAPTERS[cur].name}`;
        this.root.classList.remove("show");
        this.menuWrap.classList.add("show");
    },
    hideMenu() {
        if (!this.menuWrap) return;
        this.menuWrap.classList.remove("show");
        if (state.running && state.phase !== "final" && this.root) this.root.classList.add("show");
    },
    showFinal() {
        this.build();
        this.root.classList.remove("show");
        this.endWrap.querySelector(".dwt-end-foot").textContent = signedIn()
            ? "You're signed in so this one counts for ranked. gl"
            : "Sign in from the menu to play ranked and earn gemdust.";
        this.endWrap.classList.add("show");
        this.layout();
    },
    hideAll() {
        if (!this.root) return;
        this.root.classList.remove("show");
    },
    setVisible(on) {
        if (!this.root) return;
        this.root.classList.toggle("hidden", !on);
        this.menuWrap.classList.toggle("hidden", !on);
        this.endWrap.classList.toggle("hidden", !on);
    },
};

// Keep the keyboard with the game after a button press.
function handBackFocus() {
    try {
        const b = document.activeElement;
        if (b && b.blur) b.blur();
        const cv = document.getElementById("gameCanvas");
        if (cv && global.gameStart) cv.focus();
    } catch (e) { }
}

// Tell the server we are mid-tutorial so gems from rocks we break are held
// for us. Re-sent because respawning gives the player a fresh body.
let tutFlagAt = 0;
function sendTutorialFlag(on) {
    try { global.canvas.socket.talk("TUT", on ? 1 : 0); } catch (e) { }
}

// ── lifecycle ──────────────────────────────────────────────────────────
function open() {
    buildSteps();
    loadProgress();
    ui.build();
    listen();
    watchSocket();
    state.running = true;
    state.bursts = [];
    state.lastType = gui.type;
    state.evolveCount = 0;
    sendTutorialFlag(true);
    tutFlagAt = T();
    // Fresh plot: landmarks, no leftover bots, base neutral, one tank only.
    tut("hello");
    tut("clear");
    tut("reset");
    tut("heal");
    tut("lock", "none");
    applyAllow("", "");
    state.phase = "menu";
    ui.showMenu(false);
}

// Leave for the menu. With play=true, home.js starts a real game as soon as
// the menu is ready (see PLAY_AFTER_KEY there).
function finish(play) {
    try { localStorage.setItem(STORAGE_KEY, "1"); } catch (e) { }
    try { if (play) sessionStorage.setItem(PLAY_AFTER_KEY, "1"); } catch (e) { }
    sendTutorialFlag(false);
    state.running = false;
    state.phase = "finished";
    state.target = null;
    if (ui.endWrap) ui.endWrap.classList.add("leaving");
    // app.js asks "leave site?" whenever a game is live; this is not a match.
    try { window.onbeforeunload = null; } catch (e) { }
    try { global.canvas.socket.close(); } catch (e) { }
    global.gameStart = false;
    setTimeout(() => {
        try { location.replace(location.pathname); } catch (e) {
            try { location.reload(); } catch (e2) { }
        }
    }, 250);
}

export function isComplete() {
    try { return localStorage.getItem(STORAGE_KEY) === "1"; } catch (e) { return false; }
}
export function startTutorial() { if (!isComplete()) open(); }
export function replayTutorial() { open(); }

let startedOnce = false;
// Called every frame from app.js right after drawGUI().
export function hook() {
    // Only ever run on the tutorial server: global.tutorialPlot arrives in a
    // TUTI packet only that server sends. If the tutorial server was
    // unreachable and the client fell back to a live game, nothing starts.
    if (!startedOnce && global.tutorialMode && global.tutorialPlot &&
        global.gameStart && !global.died && terr()) {
        startedOnce = true;
        open();
    }
    if (!state.running) { ui.hideAll(); return; }
    const away = global.died || global.disconnected;
    ui.setVisible(!away);
    if (away) return;
    watchSocket();
    if (T() - tutFlagAt > 3000) { tutFlagAt = T(); sendTutorialFlag(true); }
    update();
}

// read-only handle for debugging/automation
window.dwTut = state;
// QA hooks: jump to a step id, a chapter id, "menu" or "ready".
window.dwTutJump = (id) => {
    if (!state.running) return false;
    if (id === "ready") { enterFinal(); return true; }
    if (id === "menu") { ui.showMenu(false); state.phase = "menu"; return true; }
    const ci = CHAPTERS.findIndex(c => c.id === id);
    if (ci >= 0) { enterChapter(ci); return true; }
    const i = STEPS.findIndex(st => st.id === id);
    if (i < 0) return false;
    ui.hideMenu();
    enterStep(i, true);
    return true;
};
window.dwTutSteps = () => CHAPTERS.map(c => c.id + ": " + (c.live || c.steps).map(s => s.id).join(", "));
