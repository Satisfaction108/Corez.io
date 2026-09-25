import { global } from "./global.js";
import { util } from "./util.js";
import { gui } from "./socketinit.js";
import { gameSound } from "./sound.js";

// ── Dig Royale - the practice ground ───────────────────────────────────
// An objective-driven tutorial. Instead of a dialog box telling you to "go
// break a rock", it *picks a rock*, paints its real silhouette in the world,
// walks a trail of chevrons to it, tracks that specific rock's health as you
// chip it, and bursts when it dies. Then it points at the gems that fell
// out. Then at the vault, the base, the shop, a chest, a boss, and finally
// a storm drill drawn right here on the client.
//
// Two render passes, both on the game's own canvases:
//   drawWorld(px, py, ratio)  - world-anchored markers, called from
//                               drawGameplay() so it shares the camera
//                               transform the entities were just drawn with.
//   hook()                    - screen-space HUD, called after drawGUI() so
//                               the objective card sits above everything.
//
// Progress persists in localStorage so it plays once per browser.

// Versioned: the retired in-game tutorial used "digwarsTutorialDone". Bumping
// this re-runs the (completely different, far larger) curriculum for everyone
// who "finished" the old one. home.js clears the old keys outright.
const STORAGE_KEY = "digRoyaleTutorialDone_v1";

// socketinit.js pings this on every terrain rock event; keep a cheap counter
// so steps can notice "something broke" without diffing the whole terrain.
window.dwTutorialRock = () => { window.dwRocksBroken = (window.dwRocksBroken || 0) + 1; };

// ── palette ────────────────────────────────────────────────────────────
const GOLD = "255,215,94";
const PALE = "242,234,214";
const MINT = "120,255,200";
const FONT = "Rubik, Ubuntu, sans-serif";

// ── keybind labels ─────────────────────────────────────────────────────
const DEFAULTS = {
    KEY_UP: "W", KEY_DOWN: "S", KEY_LEFT: "A", KEY_RIGHT: "D",
    KEY_AUTO_FIRE: "E", KEY_AUTO_SPIN: "C",
    KEY_AUTO_ALT: "G", KEY_TOGGLE_MAP: "M", KEY_OVER_RIDE: "R",
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
const easeOut = t => 1 - Math.pow(1 - clamp(t, 0, 1), 3);
const SW = () => global.screenWidth;
const SH = () => global.screenHeight;
// One scale factor so every glyph, pad and stroke tracks the viewport. Phones
// get a bump because the same physical size is a much smaller slice of screen.
const US = () => clamp(Math.min(SW(), SH()) / 760, 0.7, 1.45) * (global.mobile ? 1.04 : 1);

function ctxWorld() { return window.dwCtx && window.dwCtx[1]; }
function ctxGui() { return window.dwCtx && window.dwCtx[2]; }

// The camera transform drawGameplay() hands us: px/py are already ratio-scaled.
function w2s(wx, wy, px, py, ratio) {
    return { x: -px + SW() / 2 + ratio * wx, y: -py + SH() / 2 + ratio * wy };
}

function roundRect(c, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
}

// ── audio stingers (built from the game's own synth primitives) ────────
function canSound() {
    try { return !!(gameSound && gameSound._ready && gameSound._ready()); }
    catch (e) { return false; }
}
function sfxObjective() {
    if (!canSound()) return;
    try {
        gameSound._tone({ freq: 392, type: "sine", dur: 0.16, peak: 0.1, attack: 0.012 });
        gameSound._tone({ freq: 587.33, type: "sine", dur: 0.22, peak: 0.08, delay: 0.08, attack: 0.016 });
        gameSound._ring({ freqs: [784, 1175], dur: 0.2, peak: 0.035, delay: 0.1 });
    } catch (e) { }
}
function sfxAdvance() {
    if (!canSound()) return;
    try { gameSound._tone({ freq: 330, type: "sine", dur: 0.09, peak: 0.045, attack: 0.01 }); }
    catch (e) { }
}
function sfxFinale() {
    if (!canSound()) return;
    try {
        gameSound._ring({ freqs: [261.6, 329.63, 392], dur: 0.55, peak: 0.11 });
        gameSound._tone({ freq: 523.25, type: "sine", dur: 0.5, peak: 0.07, delay: 0.16, attack: 0.03 });
    } catch (e) { }
}

// ── terrain access ─────────────────────────────────────────────────────
function terr() {
    const t = window.terrainRenderer;
    return (t && t.ready && t._world && t._cellPolys) ? t : null;
}
// A rock cell's polygon and centroid live in column units; scale by world.s
// and recentre to get true world coordinates.
function rockAt(t, k) {
    const cell = t._cellPolys.get(k);
    if (!cell) return null;
    const w = t._world;
    return { k, cell, x: cell.cx * w.s - w.hw, y: cell.cy * w.s - w.hh, s: w.s, hw: w.hw, hh: w.hh };
}
function rockAlive(t, k) {
    return t._cellPolys.has(k) && !t._rockDead.has(k);
}

// ── staying inside our own arena ───────────────────────────────────────
// The tutorial room holds one arena per learner, but nothing the client
// receives is scoped to ours: the terrain renderer holds every rock in the
// room, and global.outposts / global.chambers / global.vaults are room-wide
// lists. Left alone, "the first outpost" and "the nearest rock" cheerfully
// point at a neighbour's arena - a marker the learner can see on the map and
// can never reach. Every world lookup below goes through inArena().
function arena() {
    const p = global.tutorialPlot;
    return (p && p.arena) ? p.arena : null;
}
function inArena(x, y) {
    const a = arena();
    if (!a) return true;          // not on the tutorial server: no filtering
    return x >= a.x0 && x <= a.x1 && y >= a.y0 && y <= a.y1;
}
// A landmark the server placed in OUR arena, as a target descriptor.
function landmark(key, kind, r) {
    const p = (global.tutorialPlot || {})[key];
    if (!p) return null;
    return r ? { kind, x: p.x, y: p.y, r } : { kind, x: p.x, y: p.y };
}
// Pick a rock that makes a good first target: ore-bearing if we can, and at a
// comfortable stand-off so the player has to actually aim rather than bump it.
function acquireRock(wantOre) {
    const t = terr();
    if (!t) return null;
    const px = global.player.renderx, py = global.player.rendery;
    // Judge distance in *screen* terms, not world units: the camera zoom and
    // the viewport both vary, and what actually matters is that the marked
    // rock lands comfortably inside the view - close enough to see it and the
    // marker together, far enough that you have to aim. World-unit thresholds
    // put the target in the screen corner (under the minimap) on wide screens.
    const r = util.getRatio() || 1;
    const span = Math.min(SW(), SH());
    const ideal = (span * 0.24) / r;
    // Soft preference, not a hard window: you spawn inside a cleared base
    // pocket, so the closest rock can be well outside the viewport. Score by
    // distance from ideal and always return the best candidate - if it starts
    // off-screen the edge arrow walks you to it, which is the point.
    const tooClose = 50; // overlapping the cell, not "already nearby"
    let best = null, bestScore = Infinity;
    const keys = wantOre ? t._ore.keys() : t._rockHealth.keys();
    for (const k of keys) {
        if (!rockAlive(t, k)) continue;
        const rk = rockAt(t, k);
        if (!rk) continue;
        if (!inArena(rk.x, rk.y)) continue;
        const d = Math.hypot(rk.x - px, rk.y - py);
        if (d < tooClose) continue;
        // Nearby is fine — skipping close rocks is how the marker jumped to
        // a far cell and the teleport then dumped you even farther from it.
        const score = Math.abs(d - ideal) + (d > ideal * 2 ? (d - ideal) * 0.25 : 0);
        if (score < bestScore) { bestScore = score; best = rk; }
    }
    if (!best && wantOre) return acquireRock(false);
    return best;
}
// The pad the learner can actually bank at. On the tutorial server the server
// names it outright - every arena has a red pad too, and it sits on the lethal
// base, so "nearest" is the one answer that must never be given.
function nearestVault() {
    const own = (global.tutorialPlot || {}).vault;
    if (own) return { x: own.x, y: own.y, r: 95 };
    if (!global.vaults || !global.vaults.length) return null;
    const px = global.player.renderx, py = global.player.rendery;
    let best = null, bestD = Infinity;
    for (const v of global.vaults) {
        const d = Math.hypot(v.x - px, v.y - py);
        if (d < bestD) { bestD = d; best = v; }
    }
    return best;
}

// ── the tank you are driving ───────────────────────────────────────────
// Everything the client knows about a tank's archetype comes off its mockup.
// There is no explicit "is a drone tank" flag, but the stat NAMES the server
// renames per archetype are a reliable fingerprint (a drone tank calls bullet
// damage "Drone Damage"), and a real auto-turret is a non-prop turret that
// carries guns - a Smasher's spinning shape is also a turret, but has none.
function myMockup() {
    try {
        const i = parseInt(String(gui.type).split("-")[0]);
        return global.mockups[i] || null;
    } catch (e) { return null; }
}
// The client is never told its team number outright, but gui.color arrives as
// e.g. "blue 0 1 0 false", and vaults/outposts use -1 for blue, -2 for red.
function myTeam() {
    const c = String(gui.color || "");
    if (c.indexOf("blue") === 0) return -1;
    if (c.indexOf("red") === 0) return -2;
    return 0;
}
function keybindsTabOpen() {
    const t = document.querySelector('.sp-tab[data-tab="sp-keybinds"]');
    return !!(t && t.classList.contains("active"));
}
function settingsOpen() {
    const el = document.getElementById("homeSettingsPanel");
    return !!(el && el.classList.contains("open"));
}

// ── the ten stats, in the order the skill bar shows them ───────────────
// Index here is the same index the game's own hit regions and its "x" packet
// use. gui.skills is stored in the reverse order, hence the 9 - i below.
// Blurbs describe what the stat actually does in THIS game, including its
// effect on mining: bullets chew rock faster with penetration, bullet health
// and bullet damage (server: mining.skillFactor), while a rammer grinds rock
// with body damage (server: mining.grindSecondsFor).
const STAT_INFO = [
    { i: 0, why: "How much damage you do when you drive into something. Every tank can mine by pushing into rock, so this also speeds that up." },
    { i: 1, why: "How much damage you can take before you die." },
    { i: 2, why: "How fast your bullets fly. Faster bullets are harder to dodge." },
    { i: 3, why: "How long your bullets last and how much they can hit before they break. Also helps them break rock." },
    { i: 4, why: "How well your bullets push through what they hit, rock included." },
    { i: 5, why: "How much damage each bullet does, to tanks and to rock." },
    { i: 6, why: "How quickly you shoot." },
    { i: 7, why: "How fast your tank moves. Useful for running away and for catching people." },
    { i: 8, why: "How quickly your shield refills after you get hit." },
    { i: 9, why: "How big your shield is. The shield takes damage before your health does." },
    { i: 10, why: "How fast you break rock. Mining is how you get gems, so a lot of players fill this one first." },
];
function statName(i) {
    const m = myMockup();
    if (!m) return "";                 // mockup not in yet - name is unknown
    try { return gui.getStatNames(m.statnames)[i] || ""; }
    catch (e) { return ""; }
}
// Slot 6 is renamed per archetype and means something completely different
// each time - a smasher's "Engine Acceleration" is not reload - so the blurb
// keys off the displayed name rather than the slot.
function statWhy(i) {
    const base = (STAT_INFO.find(x => x.i === i) || {}).why || "";
    if (i !== 6) return base;
    const n = statName(i);
    if (/engine/i.test(n)) return "How quickly you speed up. On a rammer that decides how hard you hit and how fast you reach someone.";
    if (/max drone/i.test(n)) return "How many drones you can have out at once.";
    if (/respawn/i.test(n)) return "How quickly you get a new drone after one is destroyed.";
    if (/density/i.test(n)) return "How heavy your shots are, which changes how hard they push.";
    return base;
}
// Bars 0..9 are stored reversed in gui.skills; Mining Power is the eleventh
// entry and sits at the bottom of the bar stack as the final stat.
function statSkill(i) { return (gui.skills || [])[i === 10 ? 10 : 9 - i] || null; }
// The digit the HUD prints beside a stat bar, and the key that spends a point
// into it. app.js draws "[" + (ticker % 10) + "]" with ticker = i + 1, so the
// tenth bar is labelled [0] rather than [10] - quote the same thing back at
// the learner or the card is telling them to press a key that is not there.
function statKey(i) { return i === 10 ? lbl("KEY_UPGRADE_MIN") : String((i + 1) % 10); }
function statUsable(i) {
    const sk = statSkill(i);
    return !!sk && sk.cap > 0;
}

// ── state ──────────────────────────────────────────────────────────────
const state = {
    running: false,
    step: -1,
    stepAt: 0,          // when the current objective began
    completedAt: 0,     // when it was satisfied (drives the flourish)
    phase: "idle",      // idle | active | clearing | finished
    target: null,       // {kind:'rock'|'point'|'vault'|'ui', ...}
    base: {},           // per-step baseline snapshot
    fireSeen: false,
    autofireCount: 0,   // auto-fire has no readable state; count the toggles
    spinOn: false,      // saw auto-spin switched on, so we can wait for off
    overrideSeen: false,
    pingSeen: false,
    mapOpened: false,   // saw the big map open, so we can wait for the close
    review: false,      // arrived here via Back, so do not auto-bounce forward
    enteredDone: false, // this objective was already satisfied on arrival
    bursts: [],         // world-space completion particles
    titleAt: 0,
    settleAt: 0,        // when an "absence" condition first held (see update)
    evolveCount: 0,     // class upgrades taken since the tutorial started
    lastType: null,
    lastBreak: null,    // where the marked rock died, for the gems objective

    // aiming lesson: accumulated cursor sweep, in radians
    aimTotal: 0,
    aimLast: null,
    // "drive and aim at once" lesson: ms spent doing both simultaneously
    bothAt: 0,
    // practice targets have to be SEEN alive before their absence counts as a
    // kill - otherwise the step completes in the frame before the bot spawns
    dummySeen: false,
    fighterSeen: false,
    // our health as a fraction of max, for the regeneration lesson
    hpFrac: 1,
    // evolveCount at the moment the second evolve step began
    evolveMark: 0,
    // world position of this plot's enemy base, learned from the room grid
    basePoint: null,
    // What the satchel held when the mining chapter began - see the rock step.
    rockBaseCarried: 0,
    // The one rock the mining objective is about. Chosen once, on arrival, and
    // never re-chosen: a marker that hops between rocks as you drive is a
    // marker you cannot follow.
    lockedRock: null,
    // Override is a pure toggle with nothing mirrored on the client, so - like
    // auto-fire - it is counted rather than read back. On for one press, off
    // for the next: the family lessons want to see the whole cycle.
    overrideCount: 0,
    // Outpost objective: how far its health has fallen, and whether it has
    // come back flying our colours.
    outpostHurt: 0,
    outpostMine: false,
    outpostDust: false,
    // Dig Royale chapter
    chestSeen: false,   // the chest existed before it vanished (= was opened)
    chestBase: 0,
    kitPeak: 0,         // most kit items held this step; a drop means one fired
    altDown: false,     // right mouse held (sidearm lesson)
    altMs: 0,
    bossSeen: false,
    lootBase: 0,
    kitDropBase: 0,     // global.kitDropped when the drop lesson began
    stormDemo: null,    // the client-side storm drill (see the "storm" step)
};

function snapshot() {
    state.base = {
        x: global.player.renderx,
        y: global.player.rendery,
        carried: global.gems.carried,
        banked: global.gems.banked,
        points: gui.points,
        type: gui.type,
        rocks: window.dwRocksBroken || 0,
        autoSpin: global.autoSpin,
        pings: global.enemyPings.length,
        statAmt: (() => {
            const sd = STEPS[state.step];
            if (!sd || sd.statIndex === undefined) return 0;
            const sk = statSkill(sd.statIndex);
            return sk ? sk.amount : 0;
        })(),
    };
    state.fireSeen = false;
    state.autofireCount = 0;
    state.aimTotal = 0;
    state.aimLast = null;
    state.bothAt = 0;
    state.spinOn = false;
    state.overrideSeen = false;
    state.overrideCount = 0;
    state.pingSeen = false;
    state.mapOpened = false;
    state.outpostHurt = 0;
    state.outpostMine = false;
    state.outpostDust = false;
}

// ── objectives ─────────────────────────────────────────────────────────
// Each: label (short, uppercase-ish), hint (tokens with {{KEY_x}} glyphs),
// acquire() to lock a world target, progress() 0..1, done() to advance.
// ── server commands ────────────────────────────────────────────────────
// The tutorial runs on its own unlisted server (gamemode "tutorial"), where
// each learner owns an isolated plot. These ask that server to stage the next
// lesson: spawn a practice target, pin the class menu to one tank, chip our
// health so the HP bar visibly moves. Every one of them is ignored outright on
// a live server - see the TUT case in server/game/network/sockets.js.
// Everything is sent as strings: the protocol will happily carry a number, but
// the server then has to guess whether "0" meant off or was just a value, and
// a command flag that reads a string "0" as true is a very quiet bug.
function tut(cmd, ...args) {
    try {
        global.canvas.socket.talk("TUT", cmd,
            ...(args.length ? args.map(a => String(a)) : [""]));
    } catch (e) { }
}

// A live enemy in our plot, if one is up. The scripted bots are the only
// enemies that can ever exist in a learner's plot, so "nearest enemy" is
// unambiguous here in a way it never is in a real match.
function practiceBot(name) {
    let best = null, bestD = Infinity;
    for (const e of global.entities) {
        if (!e || e.id === gui.playerid) continue;
        if (e.team === myTeam()) continue;
        if (!e.render || !e.render.draws) continue;
        if (name && !(e.name || "").includes(name)) continue;
        if (!inArena(e.x, e.y)) continue;
        const d = Math.hypot(e.x - global.player.cx.x, e.y - global.player.cy.y);
        if (d < bestD) { bestD = d; best = e; }
    }
    return best;
}
const botAlive = (name) => !!practiceBot(name);

// The nearest loose gem in our own arena. Gem pickups have no flag the client
// can read, but their mockups carry the ore's name, which is the same list the
// ore-tier card is built from.
const GEM_NAMES = ["Copper", "Azurite", "Core Shard", "Emerald", "Dropped Gems"];
function nearestGem() {
    const px = global.player.renderx, py = global.player.rendery;
    let best = null, bestD = Infinity;
    for (const e of global.entities) {
        if (!e || !e.index) continue;
        const m = global.mockups[String(e.index).split("-")[0]];
        if (!m || !GEM_NAMES.includes(m.name)) continue;
        if (!inArena(e.x, e.y)) continue;
        const d = Math.hypot(e.x - px, e.y - py);
        if (d < bestD) { bestD = d; best = e; }
    }
    return best;
}

// ── Dig Royale lookups ─────────────────────────────────────────────────
const CHEST_NAMES = ["Copper Chest", "Epic Chest"];
const BOSS_NAMES = ["Vault Warden", "Magma Drillhead", "Geode Colossus", "Shard Wraith"];
function nearestNamed(names) {
    const px = global.player.renderx, py = global.player.rendery;
    let best = null, bestD = Infinity;
    for (const e of global.entities) {
        if (!e || !e.index) continue;
        const m = global.mockups[String(e.index).split("-")[0]];
        if (!m || !names.includes(m.name)) continue;
        if (!inArena(e.x, e.y)) continue;
        const d = Math.hypot(e.x - px, e.y - py);
        if (d < bestD) { bestD = d; best = e; }
    }
    return best;
}
const nearestChest = () => nearestNamed(CHEST_NAMES);
const bossEntity = () => nearestNamed(BOSS_NAMES);
function hpFracOf(e) {
    if (!e || e.health === undefined) return 1;
    const h = typeof e.health === "object" ? e.health : { amount: e.health, max: 1 };
    const max = h.max || 1;
    return clamp((h.amount != null ? h.amount : max) / max, 0, 1);
}
function kitTotal() {
    const k = (global.shop && global.shop.state && global.shop.state.kit) || {};
    let n = 0;
    for (const id in k) n += k[id] | 0;
    return n;
}
// Is a gear item running? SHP carries gear as a list of ids.
function hasGear(id) {
    const g = global.shop && global.shop.state && global.shop.state.gear;
    if (!g) return false;
    return Array.isArray(g) ? g.includes(id) : !!g[id];
}
// Which kit key fires the Medkit: it lands in whichever slot was free.
function medkitKey() {
    const ko = (global.shop && global.shop.state && global.shop.state.kitOrder) || [];
    const i = Math.max(0, ko.indexOf("medkit"));
    return ["{{KEY_KIT_1}}", "{{KEY_KIT_2}}", "{{KEY_KIT_3}}"][i] || "{{KEY_KIT_1}}";
}
function shopPad() { return landmark("shop", "vault", 95); }

// How far the cursor has swung, in radians, since the step began. Used by the
// aiming lesson: the point is that the barrel FOLLOWS the mouse, so we want to
// see real sweep, not one twitch.
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

// ── objectives ─────────────────────────────────────────────────────────
// Each: label (short, uppercase-ish), hint (tokens with {{KEY_x}} glyphs),
// acquire() to lock a world target, progress() 0..1, done() to advance.
//
// There is no Back and no Next: an objective completes because the learner
// DID the thing. The only escape is "Skip tutorial".
const ALL_STEPS = [
    {
        id: "wake",
        // Clear any bots left over from a previous run at the START, not the
        // end: doing it on completion races with the spawns of later steps.
        // "reset" puts this plot's practice base back to neutral and locked.
        onEnter: () => { tut("hello"); tut("clear"); tut("reset"); },
        title: "COREZ ROYALE",
        subtitle: "This is your own copy of the raid map, just smaller. Nobody else can get in, nothing here can really hurt you, and each step waits until you've done it.",
        card: true,
        done: () => T() - state.stepAt > 3600,
    },

    // ── controls ───────────────────────────────────────────────────────
    {
        id: "aim",
        label: "Aim with your mouse",
        hint: () => "Your gun always points at your mouse cursor. *Move the mouse in a full circle around your tank* and watch the barrel follow it.",
        target: () => ({ kind: "self" }),
        onEnter: () => { state.aimTotal = 0; state.aimLast = null; },
        progress: () => clamp(aimSweep() / (Math.PI * 3), 0, 1),
        done: () => aimSweep() > Math.PI * 3,
    },
    {
        id: "move",
        label: "Drive",
        hint: () => "*{{KEY_UP}} {{KEY_LEFT}} {{KEY_DOWN}} {{KEY_RIGHT}}* move your tank up, left, down and right. Driving and aiming are separate, so you can move one way while shooting another. *Drive around the clearing for a bit.*",
        target: () => ({ kind: "self" }),
        progress: () => clamp(Math.hypot(
            global.player.renderx - state.base.x,
            global.player.rendery - state.base.y) / 260, 0, 1),
        done: () => Math.hypot(
            global.player.renderx - state.base.x,
            global.player.rendery - state.base.y) > 260,
    },
    {
        id: "moveAim",
        label: "Drive and aim at the same time",
        hint: () => "Keep the cursor pointed at one spot while you drive past it, so the barrel keeps turning to face it. *Hold a direction key and keep the mouse on one place* until the bar fills. You'll do this in every fight: run one way, shoot the other.",
        target: () => ({ kind: "self" }),
        onEnter: () => { state.aimTotal = 0; state.aimLast = null; state.bothAt = 0; },
        progress: () => clamp(state.bothAt / 1400, 0, 1),
        done: () => state.bothAt > 1400,
    },
    {
        id: "autofire",
        label: "Auto-fire",
        hint: () => global.mobile
            ? "*Tap Autofire* and your gun keeps shooting without you holding anything down. Most players leave it on all the time. *Tap it again* to switch it off."
            : "*Press {{KEY_AUTO_FIRE}}* and your gun keeps shooting without you holding the mouse button. Most players leave it on all the time. *Press {{KEY_AUTO_FIRE}} again* to switch it off.",
        target: () => ({ kind: "self" }),
        // Auto-fire is a server-side toggle with nothing mirrored on the
        // client, so there is no state to read back - count the toggles.
        progress: () => clamp(state.autofireCount / 2, 0, 1),
        done: () => state.autofireCount >= 2,
    },
    {
        id: "autospin",
        label: "Auto-spin",
        hint: () => global.mobile
            ? "*Tap Autospin* and your barrels turn in a circle on their own, shooting all around you. Handy when you're surrounded. *Tap it again* to stop."
            : "*Press {{KEY_AUTO_SPIN}}* and your barrels turn in a circle on their own, shooting all around you. Handy when you're surrounded. *Press {{KEY_AUTO_SPIN}} again* to stop.",
        target: () => ({ kind: "self" }),
        progress: () => state.spinOn ? (global.autoSpin ? 0.5 : 1) : 0,
        done: () => state.spinOn && !global.autoSpin,
    },

    // ── points and stats ───────────────────────────────────────────────
    {
        id: "points",
        allow: "",
        label: "Find your points",
        title: "YOU'VE GOT POINTS TO SPEND",
        hint: () => `Look at the bottom left. The number above the bars, \`x${gui.points || 50}\`, is how many *stat points* you have. Every tank starts with all of them unspent, so you're weaker than you need to be until you use them. *Next* walks you through each bar.`,
        ui: "points",
        next: true,
        done: () => T() - state.stepAt > 40000,
    },
    {
        id: "stats",
        allow: "stats",
        expand: true,          // replaced at chain-build time by one step per stat
        label: "Spend your stat points",
        hint: () => "Put your points into the bars.",
        ui: "skills",
        done: () => gui.points <= 0,
    },

    // ── first build, first fights ──────────────────────────────────────
    {
        id: "evolveBullet",
        allow: "upgrade",
        label: "Upgrade to Penta Shot",
        hint: () => "Your tank can change into a stronger one. The choices show up as boxes in the top left. For now there's only one option each time, so *click the box three times as it appears*: Twin, then Triple Shot, then Penta Shot.",
        ui: "upgrades",
        onEnter: () => tut("lock", "Twin,Triple Shot,Penta Shot"),
        settle: 900,
        progress: () => clamp(state.evolveCount / 3, 0, 1),
        done: () => state.evolveCount >= 3 && !(gui.upgrades || []).length,
    },
    {
        id: "health",
        label: "Watch your health",
        title: "YOUR HEALTH",
        hint: () => "I just knocked most of your health off so you can see this. The bar under your tank is your *health*. The thin one behind it is your *shield*, which takes hits first. *Both refill by themselves* if you stop taking damage for a few seconds, so when a fight goes badly, back off and let them fill.",
        onEnter: () => { tut("unlock"); tut("hurt"); },
        ui: "hp",
        target: () => ({ kind: "self" }),
        progress: () => clamp((T() - state.stepAt) / 15000, 0, 1),
        next: true,
        done: () => T() - state.stepAt > 15000,
    },
    {
        id: "dummy",
        label: "Destroy the practice dummy",
        hint: () => "This tank can't move or shoot back. *Point at it and hold left click* (or turn auto-fire on) until it breaks.",
        onEnter: () => { tut("heal"); tut("dummy"); },
        acquire: () => {
            const b = practiceBot("Dummy");
            return b ? { kind: "point", id: b.id, x: b.x, y: b.y } : null;
        },
        revalidate: () => {
            const b = practiceBot("Dummy");
            return b ? { kind: "point", id: b.id, x: b.x, y: b.y } : null;
        },
        done: () => state.dummySeen && !botAlive("Dummy"),
    },
    {
        id: "readyFight",
        label: "A bot that shoots back",
        title: "READY?",
        hint: () => "Next is a bot that *moves around and shoots at you*. It's weak on purpose, so it can hurt you but it can't kill you. *Press Go when you're ready.*",
        onEnter: () => tut("heal"),
        target: () => ({ kind: "self" }),
        next: true,
        nextLabel: "Go!",
        onDone: () => { tut("heal"); tut("fighter"); },
        done: () => false,
        noTimeout: true,
    },
    {
        id: "fighter",
        label: "Beat the rookie",
        hint: () => "*Keep moving and keep shooting at it.* Driving in circles around it makes you harder to hit. If your health gets low, drive away, wait for it to refill, then go back in.",
        acquire: () => {
            const b = practiceBot("Rookie");
            return b ? { kind: "point", id: b.id, x: b.x, y: b.y } : null;
        },
        revalidate: () => {
            const b = practiceBot("Rookie");
            return b ? { kind: "point", id: b.id, x: b.x, y: b.y } : null;
        },
        done: () => state.fighterSeen && !botAlive("Rookie"),
    },
    {
        id: "harder",
        title: "THAT WAS THE EASY ONE",
        subtitle: "Real players aim better and hit much harder than that bot. You'll lose a lot of fights at first. Everyone does, and you'll improve fast.",
        card: true,
        done: () => T() - state.stepAt > 5000,
    },

    // ── mining and money ───────────────────────────────────────────────
    {
        id: "rock",
        label: "Break the marked rock",
        hint: () => "Everything in Corez.io comes from mining. Gems are inside the rock, and *shooting rock breaks it*. The better the ore inside, the more shots it takes. *Shoot the marked rock until it breaks.*",
        onEnter: () => {
            state.lockedRock = null;
            state.rockBaseCarried = global.gems.carried;
        },
        acquire: () => {
            if (state.lockedRock && rockAlive(terr(), state.lockedRock.k)) return state.lockedRock;
            const r = acquireRock(true);
            if (r) {
                state.lockedRock = { kind: "rock", ...r };
                const px = global.player.renderx, py = global.player.rendery;
                const dx = px - r.x, dy = py - r.y;
                const d = Math.hypot(dx, dy) || 1;
                const standOff = 150;
                if (d > 220) tut("gotoxy", r.x + (dx / d) * standOff, r.y + (dy / d) * standOff);
            }
            return state.lockedRock;
        },
        progress: () => {
            const t = terr();
            const k = state.target && state.target.k;
            if (!t || k === undefined) return 0;
            const h = t._rockHealth.get(k);
            return h === undefined ? 0 : clamp(1 - h, 0, 1);
        },
        onDone: (tg) => { if (tg) state.lastBreak = { x: tg.x, y: tg.y }; },
        done: () => state.target ? !rockAlive(terr(), state.target.k) : false,
    },
    {
        id: "gems",
        label: "Pick up the gems",
        hint: () => "The rock dropped gems. *Drive over them* to pick them up. They go into your satchel, which you carry until you bank it. Gems left on the ground disappear after a little while.",
        acquire: () => {
            const g = nearestGem();
            if (g) return { kind: "point", id: g.id, x: g.x, y: g.y };
            return state.lastBreak
                ? { kind: "point", x: state.lastBreak.x, y: state.lastBreak.y }
                : null;
        },
        revalidate: () => {
            const g = nearestGem();
            return g ? { kind: "point", id: g.id, x: g.x, y: g.y } : null;
        },
        progress: () => clamp(
            (global.gems.carried - state.rockBaseCarried) / 15, 0, 1),
        done: () => global.gems.carried > state.rockBaseCarried,
    },
    {
        id: "ores",
        title: "NOT ALL ROCK IS EQUAL",
        subtitle: "These are the four ores. The better the ore, the longer the rock takes to break and the more it pays. Better ore is found further from the middle of the map.",
        card: true,
        gems: true,
        done: () => T() - state.stepAt > 8000,
    },
    {
        id: "loaded",
        label: "Look at your tank",
        title: "YOU'RE LOADED",
        hint: () => "I've filled your satchel with *4,000 gems*, the most it can hold. See the glow around your tank? *Every other player can see it too*, and it tells them you're worth killing. If you die, all of it drops on the ground for whoever gets there first. When you're carrying a lot, go and bank it.",
        onEnter: () => tut("gems", 4000),
        target: () => ({ kind: "self" }),
        next: true,
        done: () => T() - state.stepAt > 14000,
    },
    {
        id: "bank",
        allow: "bank",
        label: "Bank your gems at the vault",
        hint: () => "The *vault* is the rainbow octagon in the middle of the map. *Drive onto it*, press *DEPOSIT*, and stay on it until the bar fills. If you get shot, the deposit stops. Only one player can use a vault at a time, and it kicks you off if you just sit there.",
        onEnter: () => {
            const v = nearestVault();
            const px = global.player.renderx, py = global.player.rendery;
            if (!v || Math.hypot(px - v.x, py - v.y) > 180) tut("goto", "vault");
        },
        acquire: () => {
            const v = nearestVault();
            return v ? { kind: "vault", x: v.x, y: v.y, r: v.r || 95 } : null;
        },
        revalidate: () => {
            const v = nearestVault();
            return v ? { kind: "vault", x: v.x, y: v.y, r: v.r || 95 } : null;
        },
        progress: () => {
            const b = state.base.carried || 1;
            return clamp(1 - global.gems.carried / b, 0, 1);
        },
        done: () => global.gems.carried === 0 && global.gems.banked > state.base.banked,
    },
    {
        id: "bankRules",
        title: "BANKED GEMS ARE SAFE",
        subtitle: "Banked gems are yours for the whole raid, even if you die, and they're the only gems the shop accepts. Your score is your banked gems, plus 200 per kill, plus half of what you're carrying.",
        card: true,
        next: true,
        done: () => T() - state.stepAt > 11000,
    },

    // ── the other tank families ────────────────────────────────────────
    // Reading about a drone tank teaches nothing; flying one for twenty
    // seconds does. Two beats each: what it is, and override.
    {
        id: "droneIntro",
        label: "Try an Overlord",
        title: "DRONE TANKS",
        hint: () => "Some tanks don't have guns. This one sends out *drones that fly toward your cursor*. *Hold left click* to send them out and *let go* to bring them back. I've turned auto-fire off so you can see the difference.",
        onEnter: () => {
            tut("goto", "clearing");
            tut("morph", "overlord");
            tut("lock", "none");
            tut("cmd", "autofire", 0);
            tut("stats", "0,0,6,9,9,9,9,0,0,0");
        },
        target: () => ({ kind: "self" }),
        next: true,
        settle: 0,
        done: () => T() - state.stepAt > 20000,
    },
    {
        id: "droneOverride",
        label: "Control the drones directly",
        hint: () => "*Press {{KEY_OVER_RIDE}}* (override). Now the drones stop chasing things and just stay on your cursor, so you steer them exactly. *Press {{KEY_OVER_RIDE}} again* to turn it off.",
        target: () => ({ kind: "self" }),
        progress: () => clamp(state.overrideCount / 2, 0, 1),
        done: () => state.overrideCount >= 2,
    },
    {
        id: "autoIntro",
        label: "Try an Auto-5",
        title: "AUTO TANKS",
        hint: () => "This tank has *turrets that aim and shoot on their own*. Just drive around and they'll find targets. They're easy to use, but they won't aim as well as you can.",
        onEnter: () => {
            tut("morph", "auto5");
            tut("lock", "none");
            tut("cmd", "autofire", 0);
            tut("stats", "0,3,6,9,9,9,9,3,0,0");
        },
        target: () => ({ kind: "self" }),
        next: true,
        done: () => T() - state.stepAt > 16000,
    },
    {
        id: "autoOverride",
        label: "Aim the turrets yourself",
        hint: () => "Here's a dummy to shoot at. *Press {{KEY_OVER_RIDE}}* and the turrets aim at your cursor instead of picking their own targets. *Press {{KEY_OVER_RIDE}} again* to let them pick again. Good players use override with auto-fire on.",
        onEnter: () => tut("dummy"),
        target: () => ({ kind: "self" }),
        progress: () => clamp(state.overrideCount / 2, 0, 1),
        done: () => state.overrideCount >= 2,
    },
    {
        id: "rammerIntro",
        label: "Try a Smasher",
        title: "RAMMERS",
        hint: () => "This tank has *no guns at all*. You attack by *driving into things*: other tanks to damage them, rock to mine it. In exchange it's tougher, faster and hits harder when it rams than any tank that shoots.",
        onEnter: () => {
            tut("morph", "smasher");
            tut("lock", "none");
            tut("cmd", "autofire", 0);
            tut("cmd", "autospin", 0);
            tut("fill", 6, 1);
        },
        target: () => ({ kind: "self" }),
        next: true,
        done: () => T() - state.stepAt > 16000,
    },
    {
        id: "rammerStat",
        allow: "stats:6",
        label: () => statName(6) || "Engine Acceleration",
        hint: () => `The bullet stats are greyed out now, because this tank has no bullets. You got those points back. The one that matters here is *${statName(6) || "Engine Acceleration"}*, which is how quickly you speed up, so how hard you hit when you ram. *Put a point into it.*`,
        ui: "stat:6",
        statIndex: 6,
        progress: () => {
            const sk = statSkill(6);
            return sk && sk.amount > (state.base.statAmt || 0) ? 1 : 0;
        },
        done: () => {
            const sk = statSkill(6);
            if (!sk || !sk.cap) return true;
            return sk.amount > (state.base.statAmt || 0);
        },
    },
    {
        id: "rammerRules",
        label: "How rammers play",
        hint: () => "Auto-fire, auto-spin and override do nothing on a rammer, since there's nothing to shoot. Your body is your weapon and your pickaxe. That's all three families. You'll go back to the Penta Shot now.",
        target: () => ({ kind: "self" }),
        onDone: () => {
            tut("morph", "pentaShot");
            tut("unlock");
            tut("stats", "0,3,6,9,9,9,9,3,0,0");
        },
        next: true,
        done: () => T() - state.stepAt > 12000,
    },

    // ── bases ──────────────────────────────────────────────────────────
    {
        id: "base",
        label: "Capture the base",
        title: "BASES",
        hint: () => "The octagon east of the vault is a *base*. The grey block on it is the base's structure. *Shoot the structure until it breaks* and the base becomes yours. You'll respawn there when you die, it slowly heals you while you stand on it, and you can bank there. I've maxed your stats so this is quick.",
        onEnter: () => {
            tut("openbase");
            tut("goto", "outpost");
            tut("stats", "9,9,9,9,9,9,9,9,9,9,9");
        },
        acquire: () => landmark("outpost", "vault", 95),
        revalidate: () => landmark("outpost", "vault", 95),
        progress: () => clamp(state.outpostHurt, 0, 1),
        done: () => state.outpostMine,
    },
    {
        id: "baseBank",
        allow: "bank",
        label: "Bank at your base",
        hint: () => "A base only banks *80%* of what you drop off, but it's usually much closer than a vault when you're loaded up. I've given you *200 gems*. *Drive onto your base and press DEPOSIT.*",
        onEnter: () => {
            tut("gems", 200);
            const p = (global.tutorialPlot || {}).outpost;
            const px = global.player.renderx, py = global.player.rendery;
            if (p && Math.hypot(px - p.x, py - p.y) > 220) tut("goto", "outpost");
        },
        acquire: () => landmark("outpost", "vault", 95),
        revalidate: () => landmark("outpost", "vault", 95),
        progress: () => state.outpostDust ? clamp((200 - global.gems.carried) / 200, 0, 1) : 0,
        done: () => state.outpostDust && global.gems.carried === 0 && global.gems.banked > state.base.banked,
    },
    {
        id: "baseRules",
        title: "BASE RULES",
        subtitle: "In a raid you can stay on your base for 10 seconds, then it pushes you off and you have to wait 10 seconds to go back on. Nobody else can stand on it. If someone starts shooting it, you'll see UNDER ATTACK over it from anywhere on the map.",
        card: true,
        next: true,
        done: () => T() - state.stepAt > 12000,
    },

    // ── the shop ───────────────────────────────────────────────────────
    {
        id: "shop",
        allow: "shop",
        label: "Go to the shop",
        title: "THE SHOP",
        hint: () => "The *shop* is the teal hexagon at the end of the tunnel south of the vault. A real raid map has four of them. The shop only takes *banked* gems, and I've put *2,500* in your bank. *Drive onto the shop pad* and the shop opens.",
        onEnter: () => tut("banked", 2500),
        acquire: shopPad,
        revalidate: shopPad,
        progress: () => {
            const p = shopPad();
            if (!p) return 0;
            const d = Math.hypot(global.player.renderx - p.x, global.player.rendery - p.y);
            return clamp(1 - d / 1400, 0, 0.9);
        },
        done: () => !!global.shop.onPad,
    },
    {
        id: "shopBuy",
        allow: "shop",
        label: "Buy Drill I",
        hint: () => "A *drill* makes every shot break rock faster. Click the *DRILLS* tab, click *Drill I*, then press *BUY*. Higher drills are faster, and Drill V stays with you when you die.",
        onEnter: () => {
            global.shop.dismissed = false;
            if (!global.shop.onPad) tut("goto", "shop");
        },
        acquire: shopPad,
        revalidate: shopPad,
        progress: () => (global.shop.state && global.shop.state.drill > 0) ? 1 : 0,
        done: () => !!(global.shop.state && global.shop.state.drill > 0),
    },
    {
        id: "shopGear",
        allow: "shop",
        label: "Buy a Gem Magnet",
        title: "GEAR",
        hint: () => "*Gear* gives you a bonus for *5 minutes*, and you can have up to four running at once. What's running shows in the *GEAR* row above your kit, with the time left. Click the *GEAR* tab and buy the *Gem Magnet*, which pulls gems to you from further away.",
        onEnter: () => {
            global.shop.dismissed = false;
            if (!global.shop.onPad) tut("goto", "shop");
        },
        acquire: shopPad,
        revalidate: shopPad,
        progress: () => hasGear("magnet") ? 1 : 0,
        done: () => hasGear("magnet"),
    },

    // ── kit ────────────────────────────────────────────────────────────
    {
        id: "kit",
        allow: "kit",
        label: "Use a kit item",
        title: "KIT",
        hint: () => `*Kit items* are one-use items that sit in the *three slots above your stat bars*. You use them with *{{KEY_KIT_1}} {{KEY_KIT_2}} {{KEY_KIT_3}}*. I've taken some of your health and given you a *Medkit*. *Press ${medkitKey()} to use it.*`,
        onEnter: () => {
            tut("kit", "medkit");
            tut("hurt");
            state.kitPeak = kitTotal();
        },
        ui: "kit",
        target: () => ({ kind: "self" }),
        progress: () => kitTotal() < state.kitPeak ? 1 : 0,
        done: () => state.kitPeak > 0 && kitTotal() < state.kitPeak,
    },
    {
        id: "kitDrop",
        allow: "kit",
        label: "Throw a kit item away",
        hint: () => global.mobile
            ? "You can only hold *three different kit items*. To make room for a new one, *drag an item out of the kit box and let go*. You don't get gems back. I've given you a *Storm Anchor* to practise with. *Drag it out of the box.*"
            : "You can only hold *three different kit items*. To make room for a new one, *click and drag an item out of the kit box, then let go*. You don't get gems back. I've given you a *Storm Anchor* to practise with. *Drag it out of the box.*",
        onEnter: () => {
            tut("heal");
            tut("kit", "anchor");
            state.kitDropBase = global.kitDropped | 0;
        },
        ui: "kit",
        target: () => ({ kind: "self" }),
        progress: () => (global.kitDropped | 0) > state.kitDropBase ? 1 : 0,
        done: () => (global.kitDropped | 0) > state.kitDropBase,
    },

    // ── sidearms ───────────────────────────────────────────────────────
    {
        id: "sidearm",
        label: "Fire your sidearm",
        title: "SIDEARMS",
        hint: () => global.mobile
            ? "The shop also sells *sidearms*, a second weapon on the *alt-fire button*. I've put *Swarm Barrels* on your tank. *Hold alt-fire* to send drones at your cursor. Swarm Barrels stop working after two and a half minutes. The other sidearms are the *Drill Lance*, which breaks any rock in one hit, and the *Annihilator*, which fires one huge shell."
            : "The shop also sells *sidearms*, a second weapon on *right click*. I've put *Swarm Barrels* on your tank. *Hold right click* to send drones at your cursor. Swarm Barrels stop working after two and a half minutes. The other sidearms are the *Drill Lance*, which breaks any rock in one hit, and the *Annihilator*, which fires one huge shell.",
        onEnter: () => {
            tut("arm", "pod");
            state.altDown = false;
            state.altMs = 0;
        },
        target: () => ({ kind: "self" }),
        progress: () => clamp(state.altMs / 1500, 0, 1),
        done: () => state.altMs >= 1500,
    },

    // ── chests ─────────────────────────────────────────────────────────
    {
        id: "chest",
        label: "Break open the chest",
        title: "CHESTS",
        hint: () => "Each raid map has *six chests*: four copper and two epic. You break them like rock. A copper chest pays about *250 gems* and sometimes a kit item. An epic one pays *500* and always gives a kit item. *Shoot the marked chest until it breaks.*",
        onEnter: () => {
            state.chestSeen = false;
            state.chestBase = global.gems.carried;
            // back to the clearing first, so the chest lands in the open
            tut("goto", "clearing");
            setTimeout(() => tut("chest"), 650);
        },
        acquire: () => {
            const ch = nearestChest();
            return ch ? { kind: "point", id: ch.id, x: ch.x, y: ch.y } : null;
        },
        revalidate: () => {
            const ch = nearestChest();
            return ch ? { kind: "point", id: ch.id, x: ch.x, y: ch.y } : null;
        },
        progress: () => (state.chestSeen && !nearestChest()) ? 1 : 0,
        settle: 500,
        done: () => state.chestSeen && !nearestChest(),
    },

    // ── bosses ─────────────────────────────────────────────────────────
    {
        id: "boss",
        label: "Defeat the Vault Warden",
        title: "BOSSES",
        hint: () => "Now and then a *boss* digs its way out of the rock. You'll see it marked at the edge of your screen and on the map. This is a practice one with a tenth of the normal health. *Stay back and keep shooting it.* A real boss usually takes two or more players.",
        onEnter: () => {
            state.bossSeen = false;
            tut("heal");
            tut("goto", "clearing");
            setTimeout(() => tut("boss", "warden"), 650);
        },
        acquire: () => {
            const b = bossEntity();
            return b ? { kind: "point", id: b.id, x: b.x, y: b.y } : null;
        },
        revalidate: () => {
            const b = bossEntity();
            return b ? { kind: "point", id: b.id, x: b.x, y: b.y } : null;
        },
        progress: () => {
            const b = bossEntity();
            if (!b) return state.bossSeen ? 1 : 0;
            return clamp(1 - hpFracOf(b), 0, 1);
        },
        settle: 700,
        done: () => state.bossSeen && !bossEntity(),
    },
    {
        id: "bossLoot",
        label: "Collect the boss's gems",
        hint: () => "*Drive over the gems it dropped.* A boss is the biggest single payout in a raid, and everyone sees in the kill feed when one dies, so expect other players to show up fast.",
        onEnter: () => { state.lootBase = global.gems.carried; },
        acquire: () => {
            const g = nearestGem();
            return g ? { kind: "point", id: g.id, x: g.x, y: g.y } : null;
        },
        revalidate: () => {
            const g = nearestGem();
            return g ? { kind: "point", id: g.id, x: g.x, y: g.y } : null;
        },
        progress: () => clamp((global.gems.carried - state.lootBase) / 400, 0, 1),
        done: () => global.gems.carried - state.lootBase >= 400 ||
            (T() - state.stepAt > 6000 && !nearestGem()),
    },

    // ── the map's weather ──────────────────────────────────────────────
    {
        id: "events",
        title: "BLOOMS, METEORS, GEM RAIN",
        subtitle: "During a raid, random events drop extra gems. An ore bloom fills part of the rock with ore and keeps regrowing it for a while. Meteor showers and gem rain scatter loose gems on the ground. Each one is labelled on your minimap.",
        card: true,
        next: true,
        done: () => T() - state.stepAt > 12000,
    },

    // ── the storm, as a drill ──────────────────────────────────────────
    // Drawn entirely on the client: a purple wall closes on a marked circle
    // inside the clearing, and the step only clears once the learner is
    // standing inside it when it stops. Outside the wall the screen burns red.
    {
        id: "storm",
        label: "Get inside the circle",
        title: "THE STORM",
        hint: () => "The purple wall is the *storm*. In a raid it slowly closes in over about six minutes, stays closed for a minute, then opens again. *Being outside it hurts you*, and it hurts more each time it closes. This one is fast: *drive into the marked circle before the wall reaches you, and stay there.*",
        onEnter: () => {
            tut("heal");
            const tp = global.tutorialPlot || {};
            const cl = tp.clearing || tp.spawn || { x: global.player.renderx, y: global.player.rendery };
            let px = global.player.renderx, py = global.player.rendery;
            if (Math.hypot(px - cl.x, py - cl.y) > 500) { tut("goto", "clearing"); px = cl.x; py = cl.y; }
            // the safe circle sits across the clearing from you, inside it
            const ang = Math.atan2(py - cl.y, px - cl.x) + Math.PI;
            const off = Math.min(240, Math.max(0, (tp.clearingR || 540) - 290));
            const cx = cl.x + Math.cos(ang) * off, cy = cl.y + Math.sin(ang) * off;
            const dist = Math.hypot(px - cx, py - cy);
            state.stormDemo = {
                cx, cy, r0: Math.max(1500, dist + 320), r1: 260,
                startAt: T() + 1600, dur: 14000,
                t: 0, r: Math.max(1500, dist + 320), outside: false,
                burnMs: 0, safeSince: 0, fails: 0,
            };
        },
        acquire: () => state.stormDemo ? { kind: "zone", x: state.stormDemo.cx, y: state.stormDemo.cy } : null,
        revalidate: () => state.stormDemo ? { kind: "zone", x: state.stormDemo.cx, y: state.stormDemo.cy } : null,
        progress: () => state.stormDemo ? clamp(state.stormDemo.t, 0, 1) : 0,
        onDone: () => { state.stormDemo = null; },
        done: () => {
            const d = state.stormDemo;
            return !!d && d.t >= 1 && !d.outside && d.safeSince > 0 && T() - d.safeSince > 1200;
        },
    },
    {
        id: "override",
        title: "EVERY RAID HAS A TWIST",
        subtitle: "Each time the storm cycles, a new rule change kicks in. Everyone might be giant, or do double damage with half health, or get a free Annihilator, or there might be twelve chests instead of six. The current one is shown on the left under your quest, and a popup tells you when it changes.",
        card: true,
        next: true,
        done: () => T() - state.stepAt > 13000,
    },
    {
        id: "quests",
        title: "QUESTS AND STREAKS",
        subtitle: "The quest card on the left gives you banked gems for your first bank, chest, kill and shop visit of each raid. If you get four kills without dying, you're marked on everyone's map and your bounty doubles, so everybody comes after you.",
        card: true,
        next: true,
        done: () => T() - state.stepAt > 12000,
    },
    {
        id: "death",
        title: "DYING",
        subtitle: "When you die, everything you're carrying drops on the ground and you wait 15 seconds to respawn. You come back with a 4 second shield that lasts until you move or shoot. Insurance from the shop banks a quarter of your satchel for you instead of dropping it.",
        card: true,
        next: true,
        done: () => T() - state.stepAt > 12000,
    },
    {
        id: "finalStorm",
        title: "THE FINAL STORM",
        subtitle: "Near the end of the two-hour raid, the storm closes for good and nobody respawns. The last player alive wins, and the top ten all get paid.",
        card: true,
        next: true,
        done: () => T() - state.stepAt > 10000,
    },
    {
        id: "minimap",
        label: "Open the full map",
        hint: () => "*Press {{KEY_TOGGLE_MAP}}* to open the full map. It shows bosses, chests, events, your bases and marked players. The *Standings* tab shows everyone's score, with your name in your colour. *Press {{KEY_TOGGLE_MAP}} again* to close it.",
        ui: "minimap",
        progress: () => state.mapOpened ? (global.showBigMap ? 0.5 : 1) : 0,
        done: () => state.mapOpened && !global.showBigMap,
    },

    // ── settings ───────────────────────────────────────────────────────
    {
        id: "keys",
        group: "keys", groupPos: 1, groupLen: 3,
        omit: () => global.mobile,
        label: "Open settings",
        hint: () => "Last thing. *Click the settings button.* Every option in the game is in there.",
        ui: "dom:#ingameSettingsBtn",
        done: () => settingsOpen(),
    },
    {
        id: "keysTab",
        group: "keys", groupPos: 2, groupLen: 3,
        omit: () => global.mobile,
        label: "Find your keybinds",
        hint: () => "*Click the Keybinds tab.* It lists every control, and *you can click any of them* to change the key.",
        ui: "dom:.sp-tab[data-tab='sp-keybinds']",
        done: () => keybindsTabOpen() || !settingsOpen(),
    },
    {
        id: "keysClose",
        group: "keys", groupPos: 3, groupLen: 3,
        omit: () => global.mobile,
        label: "Close settings",
        hint: () => "*Click the X* to close settings when you're done.",
        ui: "dom:#homeSettingsClose",
        settle: 300,
        done: () => !settingsOpen(),
    },
    {
        id: "done",
        allow: "stats,upgrade,bank,shop,kit",
        title: "YOU'RE READY",
        subtitle: () => "Mine, bank often, and watch where the storm is going. Good luck.",
        card: true,
        final: true,
        done: () => T() - state.stepAt > 4000,
    },
];

function uiRect(kind) {
    const cl = global.clickables;
    if (!cl) return null;
    // app.js registers hit regions in *clickable* space:
    //   place(i, x * clickableRatio, ...)  with
    //   clickableRatio = canvas.height / screenHeight / devicePixelRatio
    // so the stored rect must be divided back out to land on the drawn UI.
    // This is recomputed every frame, which is what keeps the highlight glued
    // to the real widget across resizes, DPI changes and monitor swaps.
    const cr = (global.canvas && global.canvas.height && SH() && global.ratio)
        ? global.canvas.height / SH() / global.ratio : 1;
    if (!cr || !isFinite(cr)) return null;
    const pad = 10 * US();
    if (kind === "minimap") {
        // The minimap is drawn, not clickable, so mirror app.js's own layout
        // (drawMinimapAndDebug). Dig Wars swaps in a square terrain minimap on
        // desktop once the satchel exists; mobile keeps the top-left rect one.
        const spacing = 20;
        const len = global.mobile ? 200 / util.getScreenRatio() : 200;   // app.js alcoveSize
        const square = !global.mobile && terr() && global.gems && global.gems.cap > 0;
        const h = square ? len : (len / Math.max(1, global.gameWidth)) * global.gameHeight;
        const x = global.mobile ? spacing : SW() - spacing - len - 5;
        const y = global.mobile ? spacing : SH() - h - spacing - 5;
        return { x: x - pad, y: y - pad, w: len + pad * 2, h: h + pad * 2 };
    }
    if (kind === "hp") {
        // The health bar is world-drawn under the tank (app.js drawHealth),
        // and the tank is always dead centre, so the bar's screen rect can be
        // reconstructed from the player's own size rather than hunted for.
        const me = global.entities.find(e => e.id === gui.playerid);
        if (!me) return null;
        const r = util.getRatio() || 1;
        const size = (me.size || 20) * r;
        const real = (me.realSize || me.size || 20) * r;
        const yy = SH() / 2 + real + 14.3 * r;
        const h = 14 * r;
        return { x: SW() / 2 - size - pad, y: yy - h / 2 - pad,
                 w: size * 2 + pad * 2, h: h + pad * 2 };
    }
    const rs = [];
    if (kind === "points") {
        // The "x42" counter is drawn one row above the top stat bar, hard
        // right (app.js drawSkillBars). Derive it from the bars themselves so
        // it tracks their layout instead of guessing at screen coordinates.
        let top = null;
        for (let i = 0; i < cl.stat.size(); i++) {
            const r = cl.stat.rect(i);
            if (!r) continue;
            if (!top || r.y < top.y) top = r;
        }
        if (!top) return null;
        const x = top.x / cr, y = top.y / cr, w = top.w / cr, h = top.h / cr;
        const boxW = Math.min(w, 74 * US());
        return { x: x + w - boxW - pad, y: y - h - pad * 1.2,
                 w: boxW + pad * 2, h: h + pad * 1.6 };
    }
    if (kind && kind.indexOf("stat:") === 0) {
        rs.push(cl.stat.rect(parseInt(kind.slice(5))));
    } else if (kind === "kit") {
        if (!cl.kit) return null;
        for (let i = 0; i < cl.kit.size(); i++) rs.push(cl.kit.rect(i));
    } else if (kind === "skills") {
        for (let i = 0; i < cl.stat.size(); i++) rs.push(cl.stat.rect(i));
    } else if (kind === "upgrades") {
        const n = (gui.upgrades || []).length;
        for (let i = 0; i < n; i++) rs.push(cl.upgrade.rect(i));
    }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, any = false;
    for (const r of rs) {
        if (!r) continue;
        any = true;
        x0 = Math.min(x0, r.x / cr); y0 = Math.min(y0, r.y / cr);
        x1 = Math.max(x1, (r.x + r.w) / cr); y1 = Math.max(y1, (r.y + r.h) / cr);
    }
    if (!any) return null;
    let bx = x0 - pad, by = y0 - pad;
    let bw = x1 - x0 + pad * 2, bh = y1 - y0 + pad * 2;
    // The mobile skill bar lays its ten stats out in a row far wider than a
    // phone screen, so the raw union runs thousands of px off the edge. Clamp
    // to the viewport or we'd stroke a giant invisible rectangle.
    const m = 2 * US();
    const cx0 = Math.max(bx, m), cy0 = Math.max(by, m);
    const cx1 = Math.min(bx + bw, SW() - m), cy1 = Math.min(by + bh, SH() - m);
    if (cx1 <= cx0 || cy1 <= cy0) return null;
    return { x: cx0, y: cy0, w: cx1 - cx0, h: cy1 - cy0 };
}

// pulsing highlight around whatever live UI the current objective is about
function drawUiHighlight(c, kind) {
    const box = uiRect(kind);
    if (!box) return;
    const S = US();
    const pulse = 0.5 + 0.5 * Math.sin(T() / 260);
    c.save();
    roundRect(c, box.x, box.y, box.w, box.h, 9 * S);
    c.lineWidth = 2.5;
    c.strokeStyle = `rgba(${GOLD},${0.55 + 0.4 * pulse})`;
    c.stroke();
    c.lineWidth = 9;
    c.strokeStyle = `rgba(${GOLD},${0.07 + 0.06 * pulse})`;
    c.stroke();
    c.restore();
}

// ── step machine ───────────────────────────────────────────────────────
// active chain for this device: steps whose control does not exist here are
// dropped entirely rather than shown as busywork you cannot complete
let STEPS = ALL_STEPS;

// One objective per stat, in skill-bar order, skipping any this tank cannot
// use (a rammer's bullet stats are capped at zero). Each completes the moment
// a point actually lands in that stat, so the player learns it by doing it.
function statSteps() {
    const out = [];
    const usable = STAT_INFO.filter(si => statUsable(si.i));
    usable.forEach((si, n) => {
        out.push({
            id: "stat" + si.i,
            group: "stats",
            groupPos: n + 1,
            groupLen: usable.length + 1,
            // Exactly this bar, nothing else. Without the index the server
            // opens the whole skill bar and a learner can pour every point
            // into the first stat, skipping nine lessons in one keystroke.
            allow: "stats:" + si.i,
            label: () => statName(si.i),
            hint: () => statWhy(si.i) + (global.mobile
                ? "  *Tap the bar* to put a point into it."
                : `  *Press [[${statKey(si.i)}]]* or click the bar to *put a point into it*.`),
            ui: "stat:" + si.i,
            statIndex: si.i,
            progress: () => {
                const sk = statSkill(si.i);
                const base = state.base.statAmt || 0;
                return sk && sk.amount > base ? 1 : 0;
            },
            done: () => {
                const sk = statSkill(si.i);
                if (!sk) return true;
                if (sk.amount >= sk.cap) return true;          // nothing to spend here
                return sk.amount > (state.base.statAmt || 0);
            },
        });
    });
    // whatever is left over is theirs to place however they like
    out.push({
        id: "statsRest",
        group: "stats",
        groupPos: usable.length + 1,
        groupLen: usable.length + 1,
        label: "Spend the rest",
        hint: () => global.mobile
            ? "Spend the points you have left on whatever you like."
            : "Spend the points you have left on whatever you like. Use the number keys {{KEY_UPGRADE_ATK}} to {{KEY_UPGRADE_SHI}} and {{KEY_UPGRADE_MIN}}, or click the bars.",
        ui: "skills",
        settle: 700,
        progress: () => {
            const b = state.base.points || 1;
            return clamp(1 - gui.points / b, 0, 1);
        },
        done: () => gui.points <= 0 ||
            !(gui.skills || []).some(sk => sk.amount < sk.cap),
    });
    return out;
}

function buildChain() {
    const out = [];
    for (const st of ALL_STEPS) {
        if (st.omit && st.omit()) continue;
        if (st.expand) {
            // The generated per-stat objectives inherit the placeholder's
            // permissions - they are the steps that actually spend points.
            for (const gen of statSteps()) out.push({ allow: st.allow, ...gen });
            continue;
        }
        out.push(st);
    }
    STEPS = out;
    state.chain = STEPS.map(s => s.id);   // debug aid, mirrors window.dwTut
}

function stepDef() { return STEPS[state.step]; }

function enterStep(i, review) {
    state.step = i;
    state.review = !!review;
    state.stepAt = T();
    state.completedAt = 0;
    state.phase = "active";
    state.target = null;
    state.settleAt = 0;
    snapshot();
    const s = stepDef();
    if (!s) return finish();
    // Lessons that need the server to stage something (spawn a target, pin the
    // class menu, chip our health) do it here, once, on arrival.
    // Tell the server what this step permits. Sent for EVERY step, so a step
    // that says nothing is locked down rather than inheriting the last one's
    // permissions - that is what stops a learner dumping stat points during
    // the mining lesson or evolving into a tank the script cannot handle.
    // Mirrored on window so the HUD can hide controls the step has locked
    // (a visible bar whose clicks are refused reads as a broken game).
    window.dwTutAllow = s.allow || "";
    window.dwTutUi = typeof s.ui === "string" ? s.ui : "";
    tut("allow", s.allow || "");
    if (s.onEnter) { try { s.onEnter(); } catch (e) { } }
    if (s.acquire) state.target = s.acquire();
    // Remember whether this objective was ALREADY satisfied the moment we
    // landed on it. Revisiting a done step must not instantly bounce forward.
    state.enteredDone = false;
    try { state.enteredDone = !!s.done(state.target); } catch (e) { }
    refreshNav();
    if (s.card) { state.titleAt = T(); if (s.final) sfxFinale(); }
    else sfxAdvance();
}

function completeStep() {
    const s = stepDef();
    if (!s) return;
    state.phase = "clearing";
    state.completedAt = T();
    if (s.onDone) s.onDone(state.target);
    if (!s.card) {
        sfxObjective();
        if (state.target && (state.target.kind === "rock" || state.target.kind === "point"))
            burst(state.target.x, state.target.y);
    }
}

function advance() {
    if (state.step >= STEPS.length - 1) return finish();
    enterStep(state.step + 1);
}

function burst(x, y) {
    for (let i = 0; i < 26; i++) {
        const a = Math.random() * Math.PI * 2;
        const sp = 40 + Math.random() * 190;
        state.bursts.push({
            x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
            born: T(), life: 480 + Math.random() * 420,
        });
    }
}

function update() {
    const s = stepDef();
    if (!s) return;

    // track class evolutions wherever they happen, so the evolve objective
    // knows whether the player actually upgraded or was already max tier
    if (gui.type !== state.lastType) {
        if (state.lastType !== null) state.evolveCount++;
        state.lastType = gui.type;
    }

    if (global.showBigMap) state.mapOpened = true;
    if (global.autoSpin) state.spinOn = true;

    // Practice targets: remember having seen one alive, so "it is gone" only
    // counts as a kill after it actually existed. Without this the kill steps
    // complete instantly, in the frames before the server's spawn arrives.
    if (botAlive("Dummy")) state.dummySeen = true;
    if (botAlive("Rookie")) state.fighterSeen = true;

    // The outpost objective. global.outpostState is room-wide, so match on the
    // one whose position is our arena's - id ordering is a server-build detail
    // and not something the client should lean on.
    if (s.id === "base") {
        const mine = (global.tutorialPlot || {}).outpost;
        for (const o of (global.outpostState || [])) {
            const site = (global.outposts || []).find(x => x.id === o.id);
            if (!site || !mine) continue;
            if (Math.hypot(site.x - mine.x, site.y - mine.y) > 200) continue;
            if (o.h !== undefined) state.outpostHurt = Math.max(state.outpostHurt, 1 - o.h);
            if (o.o && o.o === gui.playerid) state.outpostMine = true;
        }
    }
    if (s.id === "baseBank" && (global.gems.carried | 0) >= 150) state.outpostDust = true;

    // Dig Royale chapter: presence before absence, same rule as the bots.
    if (s.id === "chest" && nearestChest()) state.chestSeen = true;
    if (s.id === "boss" && bossEntity()) state.bossSeen = true;
    if (s.id === "kit") {
        state.kitPeak = Math.max(state.kitPeak, kitTotal());
        // A maxed tank regenerates to full in seconds and a Medkit at full
        // health is refused, so keep the bar visibly low until it is used.
        if (state.hpFrac > 0.6 && T() - (state.lastHurtAt || 0) > 3000) {
            tut("hurt");
            state.lastHurtAt = T();
        }
    }
    if (s.id === "sidearm") {
        // Real elapsed time while the button is held, not a frame count, so a
        // slow machine is not asked to hold it ten times longer.
        const mobileAlt = !!(global.clickables && global.clickables.mobileButtons && global.clickables.mobileButtons.altFire);
        const now = T();
        if (state.altDown || mobileAlt) state.altMs += Math.min(100, now - (state.altLast || now));
        state.altLast = now;
    }

    // The storm drill: shrink the wall, notice when the learner is outside it,
    // and once it has stopped, either count them safe or start it over.
    if (s.id === "storm" && state.stormDemo) {
        const d = state.stormDemo;
        const now = T();
        d.t = clamp((now - d.startAt) / d.dur, 0, 1);
        d.r = lerp(d.r0, d.r1, smooth(d.t));
        const dist = Math.hypot(global.player.renderx - d.cx, global.player.rendery - d.cy);
        d.outside = now >= d.startAt && dist > d.r;
        if (d.outside) d.burnMs += 16;
        if (d.t >= 1) {
            if (!d.outside) { if (!d.safeSince) d.safeSince = now; }
            else {
                d.safeSince = 0;
                // stood outside when it stopped: open it back up and go again
                if (now - d.startAt > d.dur + 2600) {
                    d.fails++;
                    d.startAt = now + 800;
                    d.r0 = Math.max(1500, dist + 320);
                    d.t = 0;
                }
            }
        }
    }

    // Our own health, for the regeneration lesson.
    const me = global.entities.find(e => e.id === gui.playerid);
    if (me && me.health !== undefined) {
        const h = typeof me.health === "object" ? me.health : { amount: me.health, max: 1 };
        const max = h.max || 1;
        state.hpFrac = clamp((h.amount != null ? h.amount : max) / max, 0, 1);
    }

    // "Drive and aim at once": accumulate time where the tank is genuinely
    // moving AND the cursor is genuinely swinging. Sitting still with a
    // wiggling mouse should not tick this along.
    if (s.id === "moveAim") {
        const moving = Math.abs(global.player.renderx - state.moveAimLastX || 0) > 0.6 ||
                       Math.abs(global.player.rendery - state.moveAimLastY || 0) > 0.6;
        const before = state.aimTotal;
        aimSweep();
        const swinging = state.aimTotal - before > 0.004;
        if (moving && swinging) state.bothAt += 16;
        state.moveAimLastX = global.player.renderx;
        state.moveAimLastY = global.player.rendery;
    }

    if (state.phase === "active") {
        // Success is checked BEFORE re-targeting: for the rock objective the
        // target's death *is* the win condition, and revalidate treats a dead
        // rock as "lost" - re-acquiring first would swap in a fresh live rock
        // every time you broke one, so the step could never complete.
        const isDone = s.done(state.target);
        if (state.review && isDone && state.enteredDone) {
            state.settleAt = 0;          // already satisfied when we came back
        } else if (isDone) {
            // Some conditions are "absence of something" (no upgrades left to
            // pick, no points left to spend) and flicker while the server
            // sends the next batch - hold them steady before accepting.
            if (!s.settle) completeStep();
            else if (!state.settleAt) state.settleAt = T();
            else if (T() - state.settleAt > s.settle) completeStep();
        } else {
            state.settleAt = 0;
            if (s.revalidate) {
                const next = s.revalidate(state.target);
                state.target = (!next && s.acquire) ? s.acquire() : next;
            } else if (!state.target && s.acquire) {
                state.target = s.acquire();
            }
        }
    } else if (state.phase === "clearing") {
        const wait = s.card ? 620 : 900;
        if (T() - state.completedAt > wait) advance();
    }

    // SOFT-LOCK ESCAPE. Every objective here is satisfied by doing something,
    // and there is no Next button by design - which means a step whose
    // condition can never be met would trap a beginner forever. If an
    // objective has been on screen this long, we assume it is unreachable
    // (the bot never spawned, the vault is unreachable, a control is unbound)
    // and move on rather than stranding them. Cards exempt: they time out.
    if (state.phase === "active" && !s.card && !s.noTimeout &&
        T() - state.stepAt > STUCK_MS) {
        completeStep();
    }
}

// Generous on purpose: long enough that nobody is rushed through a lesson they
// are still working on, short enough that a broken step is an annoyance rather
// than a dead end.
const STUCK_MS = 150000;

// ── world pass ─────────────────────────────────────────────────────────
export function drawWorld(px, py, ratio) {
    const c = ctxWorld();
    state.edge = null;
    if (!c || !state.running) return;
    const now = T();

    // completion debris always draws, even after the step moved on
    if (state.bursts.length) {
        c.save();
        for (let i = state.bursts.length - 1; i >= 0; i--) {
            const p = state.bursts[i];
            const age = (now - p.born) / p.life;
            if (age >= 1) { state.bursts.splice(i, 1); continue; }
            const t = age;
            const wx = p.x + p.vx * t, wy = p.y + p.vy * t;
            const sp = w2s(wx, wy, px, py, ratio);
            c.globalAlpha = (1 - t) * 0.9;
            c.fillStyle = `rgb(${GOLD})`;
            const r = (2.6 - 2 * t) * ratio * 1.6;
            c.beginPath(); c.arc(sp.x, sp.y, Math.max(0.6, r), 0, Math.PI * 2); c.fill();
        }
        c.restore();
    }

    const s = stepDef();
    if (!s) return;
    const tg = state.target;
    if (!tg) return;

    const clearing = state.phase === "clearing";
    const fade = clearing ? 1 - clamp((now - state.completedAt) / 520, 0, 1) : 1;
    if (fade <= 0) return;

    if (tg.kind === "self") { drawSelfRing(c, px, py, ratio, fade); return; }
    if (tg.kind === "zone") {
        drawStormDrill(c, px, py, ratio, fade);
        const zp = w2s(tg.x, tg.y, px, py, ratio);
        const zOn = zp.x > -60 && zp.x < SW() + 60 && zp.y > -60 && zp.y < SH() + 60;
        if (zOn) drawChevrons(c, zp, px, py, ratio, fade);
        else state.edge = { sp: { x: zp.x, y: zp.y }, tg: { x: tg.x, y: tg.y }, fade, at: T() };
        return;
    }

    const sp = w2s(tg.x, tg.y, px, py, ratio);
    const onScreen = sp.x > -60 && sp.x < SW() + 60 && sp.y > -60 && sp.y < SH() + 60;
    // last known screen position of the marker, in logical units (debug aid)
    state.screen = { x: sp.x, y: sp.y, sw: SW(), sh: SH(), on: onScreen };

    if (onScreen) {
        if (tg.kind === "rock") drawRockTarget(c, tg, sp, px, py, ratio, fade);
        else if (tg.kind === "vault") drawVaultTarget(c, tg, sp, ratio, fade);
        else drawPointTarget(c, sp, ratio, fade);
        drawChevrons(c, sp, px, py, ratio, fade);
    } else {
        // queued for the late pass; drawing it here would put it under the
        // whole GUI, since this runs during the gameplay pass
        state.edge = { sp: { x: sp.x, y: sp.y }, tg: { x: tg.x, y: tg.y }, fade, at: T() };
    }
}

// pulse ring around your own tank (move / fire steps)
function drawSelfRing(c, px, py, ratio, fade) {
    const s = stepDef();
    const sp = { x: SW() / 2, y: SH() / 2 };
    const now = T();
    const pr = s && s.progress ? s.progress() : 0;
    const R = 46 * ratio * 0.9 + 6 * Math.sin(now / 260);
    c.save();
    c.globalAlpha = 0.5 * fade;
    c.lineWidth = 2.5;
    c.strokeStyle = `rgb(${GOLD})`;
    c.setLineDash([7, 9]);
    c.lineDashOffset = -now / 26;
    c.beginPath(); c.arc(sp.x, sp.y, R, 0, Math.PI * 2); c.stroke();
    c.setLineDash([]);
    if (pr > 0) {
        c.globalAlpha = 0.95 * fade;
        c.lineWidth = 3.5;
        c.beginPath();
        c.arc(sp.x, sp.y, R, -Math.PI / 2, -Math.PI / 2 + pr * Math.PI * 2);
        c.stroke();
    }
    c.restore();
}

// The storm drill: the same purple wall the real game draws, closing on a
// gold safe circle. Everything outside the wall is dimmed like the real storm.
function drawStormDrill(c, px, py, ratio, fade) {
    const d = state.stormDemo;
    if (!d) return;
    const now = T();
    const sp = w2s(d.cx, d.cy, px, py, ratio);
    const rr = Math.max(0, d.r * ratio);
    c.save();
    c.globalAlpha = fade;
    c.beginPath();
    c.rect(-40, -40, SW() + 80, SH() + 80);
    c.arc(sp.x, sp.y, rr, 0, Math.PI * 2, true);
    c.clip("evenodd");
    c.fillStyle = "rgba(72, 38, 96, 0.46)";
    c.fillRect(-40, -40, SW() + 80, SH() + 80);
    c.restore();
    c.save();
    c.globalAlpha = fade;
    const wall = Math.max(8, 12 * ratio);
    c.beginPath();
    c.arc(sp.x, sp.y, rr + wall, 0, Math.PI * 2);
    c.arc(sp.x, sp.y, Math.max(0, rr - 2), 0, Math.PI * 2, true);
    c.fillStyle = "#6a3a78";
    c.fill("evenodd");
    c.strokeStyle = "#2a1028";
    c.lineWidth = Math.max(2, 2.5 * ratio);
    c.beginPath(); c.arc(sp.x, sp.y, rr, 0, Math.PI * 2); c.stroke();
    // the safe circle: where the wall will stop
    const pulse = 0.5 + 0.5 * Math.sin(now / 320);
    const zr = d.r1 * ratio;
    c.globalAlpha = (0.55 + 0.4 * pulse) * fade;
    c.strokeStyle = `rgb(${GOLD})`;
    c.lineWidth = 3;
    c.setLineDash([12, 10]);
    c.lineDashOffset = -now / 30;
    c.beginPath(); c.arc(sp.x, sp.y, zr, 0, Math.PI * 2); c.stroke();
    c.setLineDash([]);
    c.globalAlpha = 0.10 * fade;
    c.fillStyle = `rgb(${GOLD})`;
    c.beginPath(); c.arc(sp.x, sp.y, zr, 0, Math.PI * 2); c.fill();
    c.restore();
    drawCaret(c, sp.x, sp.y - zr - 26, fade);
}

// Red edges and a line of text while the learner stands in the drill's storm.
function drawStormDrillHud(c) {
    const d = state.stormDemo;
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
    c.restore();
    trackedText(c, "YOU'RE IN THE STORM. GET INSIDE.", cx, SH() * 0.68, 18 * S, "#ff8a7a", 1.6 * S, 0.85 + 0.15 * pulse);
    c.globalAlpha = 1;
}

// the marked rock: its real silhouette, breathing brackets, damage arc
function drawRockTarget(c, tg, sp, px, py, ratio, fade) {
    const t = terr();
    const now = T();
    const pulse = 0.5 + 0.5 * Math.sin(now / 300);
    let minX = sp.x, minY = sp.y, maxX = sp.x, maxY = sp.y;

    if (t) {
        const cell = t._cellPolys.get(tg.k);
        const w = t._world;
        if (cell && cell.poly && cell.poly.length > 2) {
            c.save();
            c.beginPath();
            for (let i = 0; i < cell.poly.length; i++) {
                const wx = cell.poly[i][0] * w.s - w.hw;
                const wy = cell.poly[i][1] * w.s - w.hh;
                const p = w2s(wx, wy, px, py, ratio);
                if (i === 0) c.moveTo(p.x, p.y); else c.lineTo(p.x, p.y);
                minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
                minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
            }
            c.closePath();
            c.globalAlpha = (0.10 + 0.07 * pulse) * fade;
            c.fillStyle = `rgb(${GOLD})`;
            c.fill();
            c.globalAlpha = (0.75 + 0.25 * pulse) * fade;
            c.strokeStyle = `rgb(${GOLD})`;
            c.lineWidth = 2.5;
            c.setLineDash([9, 7]);
            c.lineDashOffset = -now / 34;
            c.stroke();
            c.setLineDash([]);
            c.restore();
        }
    }

    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    const half = Math.max(26, Math.max(maxX - minX, maxY - minY) / 2 + 12);
    drawBrackets(c, cx, cy, half + 5 * pulse, fade);

    const s = stepDef();
    const pr = s && s.progress ? s.progress(tg) : 0;
    if (pr > 0.001) drawArc(c, cx, cy, half + 13, pr, fade);
    drawCaret(c, cx, cy - half - 20, fade);
}

function drawVaultTarget(c, tg, sp, ratio, fade) {
    const now = T();
    const pulse = 0.5 + 0.5 * Math.sin(now / 320);
    const R = Math.max(34, tg.r * ratio * 1.12);
    c.save();
    c.globalAlpha = (0.55 + 0.4 * pulse) * fade;
    c.strokeStyle = `rgb(${GOLD})`;
    c.lineWidth = 3;
    c.setLineDash([12, 10]);
    c.lineDashOffset = -now / 30;
    c.beginPath(); c.arc(sp.x, sp.y, R, 0, Math.PI * 2); c.stroke();
    c.restore();
    drawBrackets(c, sp.x, sp.y, R + 12 + 4 * pulse, fade);
    drawCaret(c, sp.x, sp.y - R - 26, fade);
}

function drawPointTarget(c, sp, ratio, fade) {
    const now = T();
    const pulse = 0.5 + 0.5 * Math.sin(now / 240);
    c.save();
    c.globalAlpha = (0.6 + 0.4 * pulse) * fade;
    c.strokeStyle = `rgb(${MINT})`;
    c.lineWidth = 3;
    for (let i = 0; i < 2; i++) {
        const t = ((now / 1100) + i * 0.5) % 1;
        c.globalAlpha = (1 - t) * 0.75 * fade;
        c.beginPath();
        c.arc(sp.x, sp.y, 16 + t * 52, 0, Math.PI * 2);
        c.stroke();
    }
    c.restore();
    drawCaret(c, sp.x, sp.y - 46, fade, MINT);
}

function drawBrackets(c, cx, cy, r, fade) {
    const arm = r * 0.42;
    c.save();
    c.globalAlpha = 0.9 * fade;
    c.strokeStyle = `rgb(${GOLD})`;
    c.lineWidth = 3;
    c.lineCap = "round";
    for (let i = 0; i < 4; i++) {
        const sx = i & 1 ? 1 : -1, sy = i & 2 ? 1 : -1;
        const x = cx + sx * r, y = cy + sy * r;
        c.beginPath();
        c.moveTo(x - sx * arm, y); c.lineTo(x, y); c.lineTo(x, y - sy * arm);
        c.stroke();
    }
    c.restore();
}

function drawArc(c, cx, cy, r, pr, fade) {
    c.save();
    c.globalAlpha = 0.28 * fade;
    c.strokeStyle = `rgb(${PALE})`;
    c.lineWidth = 4;
    c.beginPath(); c.arc(cx, cy, r, 0, Math.PI * 2); c.stroke();
    c.globalAlpha = 0.95 * fade;
    c.strokeStyle = `rgb(${GOLD})`;
    c.lineCap = "round";
    c.beginPath();
    c.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + clamp(pr, 0, 1) * Math.PI * 2);
    c.stroke();
    c.restore();
}

// bobbing diamond above a target
function drawCaret(c, x, y, fade, col = GOLD) {
    const bob = Math.sin(T() / 300) * 5;
    c.save();
    c.translate(x, y + bob);
    c.globalAlpha = 0.95 * fade;
    c.fillStyle = `rgb(${col})`;
    c.strokeStyle = "rgba(0,0,0,.55)";
    c.lineWidth = 2;
    c.beginPath();
    c.moveTo(0, 9); c.lineTo(8, -4); c.lineTo(-8, -4);
    c.closePath();
    c.fill(); c.stroke();
    c.restore();
}

// a short trail of chevrons from the player toward the target
function drawChevrons(c, sp, px, py, ratio, fade) {
    const ox = SW() / 2, oy = SH() / 2;
    const dx = sp.x - ox, dy = sp.y - oy;
    const dist = Math.hypot(dx, dy);
    if (dist < 150) return;
    const ang = Math.atan2(dy, dx);
    const now = T();
    const n = Math.min(4, Math.floor(dist / 90));
    c.save();
    c.strokeStyle = `rgb(${GOLD})`;
    c.lineWidth = 3;
    c.lineCap = "round";
    for (let i = 0; i < n; i++) {
        const t = ((now / 1300) + i / n) % 1;
        const d = lerp(74, Math.min(dist - 46, 74 + n * 90), t);
        const x = ox + Math.cos(ang) * d, y = oy + Math.sin(ang) * d;
        c.globalAlpha = Math.sin(t * Math.PI) * 0.5 * fade;
        c.save();
        c.translate(x, y); c.rotate(ang);
        c.beginPath();
        c.moveTo(-6, -7); c.lineTo(4, 0); c.lineTo(-6, 7);
        c.stroke();
        c.restore();
    }
    c.restore();
}

// Off-screen target: matches the game's own leader indicator so the two read
// as the same language - projected onto the screen RECTANGLE (not an ellipse,
// which floats the arrow away from the corners), the same sleek dart, and a
// distance readout under it.
function drawEdgeArrow(c_unused, sp, tg, fade) {
    const c = ctxGui();
    if (!c) return;
    const S = US();
    const cx = SW() / 2, cy = SH() / 2;
    const ang = Math.atan2(sp.y - cy, sp.x - cx);
    const inset = 30 * S;
    const t = Math.min((cx - inset) / (Math.abs(Math.cos(ang)) || 1e-9),
                       (cy - inset) / (Math.abs(Math.sin(ang)) || 1e-9));
    const ax = cx + Math.cos(ang) * t, ay = cy + Math.sin(ang) * t;
    const now = T();
    const pulse = 1 + 0.06 * Math.sin(now / 280);
    const dist = Math.hypot(tg.x - global.player.renderx, tg.y - global.player.rendery);

    c.save();
    c.globalAlpha = fade * 0.95;
    c.translate(ax, ay);
    c.save();
    c.rotate(ang);
    c.scale(pulse * S, pulse * S);
    c.beginPath();
    c.moveTo(16, 0);
    c.lineTo(-10, -11);
    c.lineTo(-4.5, 0);
    c.lineTo(-10, 11);
    c.closePath();
    c.lineWidth = 3.5;
    c.strokeStyle = "#000";
    c.stroke();
    c.fillStyle = `rgb(${GOLD})`;
    c.fill();
    c.restore();

    // distance sits back along the arrow, inside the screen
    const tx = -Math.cos(ang) * 30 * S, ty = -Math.sin(ang) * 30 * S;
    const txt = Math.round(dist / 10) + "m";
    c.font = `800 ${12 * S}px ${FONT}`;
    c.textAlign = "center";
    c.textBaseline = "middle";
    c.lineWidth = 3.5;
    c.strokeStyle = "rgba(0,0,0,.8)";
    c.strokeText(txt, tx, ty);
    c.fillStyle = `rgb(${PALE})`;
    c.fillText(txt, tx, ty);
    c.restore();
}

// Drawn from the very end of the frame so no GUI element can cover it.
export function drawIndicators() {
    if (!state.running || global.died || global.disconnected) return;
    const e = state.edge;
    if (!e || T() - e.at > 250) return;
    drawEdgeArrow(null, e.sp, e.tg, e.fade);
}

// ── HUD pass ───────────────────────────────────────────────────────────
// Hint text is tokenised so it can carry four things inline:
//   {{KEY_X}}   a real keycap glyph for whatever that action is bound to
//   [[1]]       a keycap for a literal key, where there is no binding to look
//               up - the stat bars are numbered [1]..[0] by the HUD itself
//   *emphasis*  the words that are the actual instruction, drawn bold and
//               gold - a wall of even grey text hides the one clause that
//               says what to press
//   `x42`       a boxed literal, for naming a number that is also on screen
//               somewhere ("the x42 above the bars") so the two read as the
//               same object
//
// Markers nest: an instruction is nearly always "press THIS key", so the
// keycaps have to survive being wrapped in emphasis. Scanning bold runs as
// plain words is what printed a raw "{{KEY_AUTO_FIRE}}" on screen.
const TOK_RE = /\{\{(KEY_[A-Z0-9_]+)\}\}|\[\[([^\]]+)\]\]|`([^`]+)`/g;

// Everything except emphasis, which is handled by the caller so it can set the
// weight of the words it produces.
function tokenizeRun(str, weight, out) {
    TOK_RE.lastIndex = 0;
    let last = 0, m;
    const plain = (chunk) => {
        for (const w of chunk.split(/\s+/).filter(Boolean)) out.push({ t: weight, s: w });
    };
    while ((m = TOK_RE.exec(str))) {
        if (m.index > last) plain(str.slice(last, m.index));
        if (m[1] !== undefined) out.push({ t: "k", s: lbl(m[1]) });
        else if (m[2] !== undefined) out.push({ t: "k", s: m[2] });
        else out.push({ t: "v", s: m[3] });
        last = m.index + m[0].length;
    }
    plain(str.slice(last));
}

function tokenize(str) {
    const out = [];
    const bold = /\*([^*]+)\*/g;
    let last = 0, m;
    while ((m = bold.exec(str))) {
        if (m.index > last) tokenizeRun(str.slice(last, m.index), "w", out);
        tokenizeRun(m[1], "b", out);
        last = m.index + m[0].length;
    }
    tokenizeRun(str.slice(last), "w", out);
    return out;
}

function measure(c, tok, S) {
    if (tok.t === "k") {
        c.font = `800 ${12 * S}px ${FONT}`;
        return Math.max(20 * S, c.measureText(tok.s).width + 14 * S);
    }
    if (tok.t === "v") {
        c.font = `800 ${13 * S}px ${FONT}`;
        return c.measureText(tok.s).width + 12 * S;
    }
    c.font = `${tok.t === "b" ? 800 : 500} ${14 * S}px ${FONT}`;
    return c.measureText(tok.s).width;
}

// A comma or full stop that fell outside an emphasis run ("*like this*,") is
// its own token, and spacing it like a word prints "like this ,". Punctuation
// hugs whatever came before it instead.
const HUGS_LEFT = /^[.,;:!?)\]]/;

function layout(c, tokens, maxW, S) {
    const space = 4.5 * S;
    const lines = [];
    let cur = [], w = 0;
    for (const tok of tokens) {
        const tw = measure(c, tok, S);
        // Keycaps and boxed values are chrome, not glyphs: they always want
        // their own breathing room even before a comma.
        const glue = cur.length && tok.t !== "k" && tok.t !== "v" && HUGS_LEFT.test(tok.s);
        const gap = cur.length && !glue ? space : 0;
        if (cur.length && !glue && w + gap + tw > maxW) {
            lines.push({ toks: cur, w });
            cur = []; w = 0;
            cur.push({ tok, w: tw, gap: 0 });
            w += tw;
            continue;
        }
        cur.push({ tok, w: tw, gap });
        w += gap + tw;
    }
    if (cur.length) lines.push({ toks: cur, w });
    return lines;
}

function drawLine(c, line, cx, y, S) {
    let x = cx - line.w / 2;
    for (const it of line.toks) {
        x += it.gap || 0;
        if (it.tok.t === "k") {
            const h = 19 * S;
            roundRect(c, x, y - h / 2, it.w, h, 5 * S);
            c.fillStyle = "rgba(6,7,10,.92)";
            c.fill();
            c.strokeStyle = `rgba(${GOLD},.75)`;
            c.lineWidth = 1.5;
            c.stroke();
            c.font = `800 ${12 * S}px ${FONT}`;
            c.fillStyle = `rgb(${GOLD})`;
            c.textAlign = "center";
            c.fillText(it.tok.s, x + it.w / 2, y + 0.5 * S);
        } else if (it.tok.t === "v") {
            const h = 19 * S;
            roundRect(c, x, y - h / 2, it.w, h, 4 * S);
            c.fillStyle = `rgba(${GOLD},.13)`;
            c.fill();
            c.strokeStyle = `rgba(${GOLD},.55)`;
            c.lineWidth = 1.5;
            c.stroke();
            c.font = `800 ${13 * S}px ${FONT}`;
            c.fillStyle = `rgb(${GOLD})`;
            c.textAlign = "center";
            c.fillText(it.tok.s, x + it.w / 2, y + 0.5 * S);
        } else if (it.tok.t === "b") {
            c.font = `800 ${14 * S}px ${FONT}`;
            c.fillStyle = `rgb(${GOLD})`;
            c.textAlign = "left";
            c.fillText(it.tok.s, x, y);
        } else {
            c.font = `500 ${14 * S}px ${FONT}`;
            c.fillStyle = `rgba(${PALE},.93)`;
            c.textAlign = "left";
            c.fillText(it.tok.s, x, y);
        }
        x += it.w;
    }
}

// wide-tracked uppercase, drawn glyph by glyph (canvas letterSpacing is not
// universally supported, and we want exact centring regardless)
function trackedText(c, str, cx, y, size, color, track, alpha) {
    c.font = `800 ${size}px ${FONT}`;
    c.textAlign = "left";
    c.textBaseline = "middle";
    const chars = [...str];
    let total = 0;
    for (const ch of chars) total += c.measureText(ch).width + track;
    total -= track;
    let x = cx - total / 2;
    c.globalAlpha = alpha;
    for (const ch of chars) {
        const w = c.measureText(ch).width;
        c.lineWidth = Math.max(3, size / 7);
        c.strokeStyle = "rgba(0,0,0,.7)";
        c.strokeText(ch, x, y);
        c.fillStyle = color;
        c.fillText(ch, x, y);
        x += w + track;
    }
}

// The four ore tiers. Drawn with the same baked gem sprites the world uses
// (glow, facet, sparkle, palette) so the card matches what actually drops.
const GEM_LEGEND = [
    { label: "Copper",     worth: "15",  cls: "gemPickupCopper",  size: 16 },
    { label: "Azurite",    worth: "30",  cls: "gemPickupVein",    size: 20 },
    { label: "Core Shard", worth: "150", cls: "gemPickupShard",   size: 30 },
    { label: "Emerald",    worth: "500", cls: "gemPickupEmerald", size: 34 },
];

function drawGemLegend(c, cx, y, alpha) {
    const S = US();
    const drawGem = window.dwDrawGem;
    const slot = Math.min(SW() * 0.20, 118 * S);
    const n = GEM_LEGEND.length;
    let x = cx - (n - 1) * slot / 2;
    const unit = Math.min(0.95 * S, (slot * 0.30) / 34);
    const maxBody = 34 * unit;
    const wob = T() / 620;
    const labelY = y + maxBody * 1.55 + 16 * S;
    const worthY = labelY + 18 * S;

    for (let i = 0; i < n; i++) {
        const g = GEM_LEGEND[i];
        const bodyPx = g.size * unit;
        let drew = false;
        if (drawGem) {
            try {
                drawGem(c, x, y, bodyPx, alpha, wob * 0.4, g.cls);
                drew = true;
            } catch (e) { drew = false; }
        }
        if (!drew) {
            c.save();
            c.globalAlpha = alpha * 0.5;
            c.fillStyle = `rgba(${PALE},.5)`;
            c.beginPath(); c.arc(x, y, bodyPx * 0.45, 0, Math.PI * 2); c.fill();
            c.restore();
        }

        c.save();
        c.globalAlpha = alpha;
        c.font = `700 ${12 * S}px ${FONT}`;
        c.textAlign = "center";
        c.textBaseline = "middle";
        c.lineWidth = 3;
        c.strokeStyle = "rgba(0,0,0,.7)";
        c.strokeText(g.label, x, labelY);
        c.fillStyle = `rgba(${PALE},.95)`;
        c.fillText(g.label, x, labelY);

        c.font = `800 ${11 * S}px ${FONT}`;
        c.strokeText(g.worth, x, worthY);
        c.fillStyle = `rgba(${GOLD},.9)`;
        c.fillText(g.worth, x, worthY);
        c.restore();
        x += slot;
    }
    return worthY;
}

function drawTitleCard(c, s) {
    const S = US();
    const t = T() - state.stepAt;
    const inA = smooth(t / 700);
    const outA = state.phase === "clearing"
        ? 1 - smooth((T() - state.completedAt) / 560) : 1;
    const a = inA * outA;
    if (a <= 0) return;
    const cx = SW() / 2, cy = SH() * (s.gems ? (global.mobile ? 0.24 : 0.28) : (global.mobile ? 0.32 : 0.36));

    // vignette so the card reads over a busy cavern
    const g = c.createRadialGradient(cx, cy, 0, cx, cy, Math.max(SW(), SH()) * 0.72);
    g.addColorStop(0, `rgba(0,0,0,${0.62 * a})`);
    g.addColorStop(1, "rgba(0,0,0,0)");
    c.save();
    c.fillStyle = g;
    c.fillRect(0, 0, SW(), SH());

    // Tracked capitals: each glyph ~0.62em plus 0.16em of letter spacing, so
    // long titles ("THAT WAS THE EASY VERSION") shrink to fit narrow windows.
    const n = s.title.length;
    const size = Math.min(54 * S, (SW() * 0.94) / (n * 0.62 + Math.max(0, n - 1) * 0.16));
    const rise = (1 - inA) * 14;
    trackedText(c, s.title, cx, cy - rise, size, `rgb(${GOLD})`, size * 0.16, a);

    // hairline rules that draw themselves outward
    const halfW = Math.min(SW() * 0.34, 240 * S) * easeOut(t / 900);
    c.globalAlpha = a * 0.75;
    c.strokeStyle = `rgba(${GOLD},.6)`;
    c.lineWidth = 1.5;
    c.beginPath();
    c.moveTo(cx - halfW, cy + size * 0.72); c.lineTo(cx + halfW, cy + size * 0.72);
    c.stroke();

    const subtitle = typeof s.subtitle === "function" ? s.subtitle() : s.subtitle;
    let subBottom = cy + size * 0.72;
    if (subtitle) {
        c.globalAlpha = a * smooth((t - 320) / 700);
        c.font = `500 ${15 * S}px ${FONT}`;
        c.textAlign = "center";
        c.textBaseline = "middle";
        c.lineWidth = 3;
        c.strokeStyle = "rgba(0,0,0,.6)";
        const subMax = Math.min(SW() * 0.72, 420 * S);
        const subLines = layout(c, tokenize(subtitle), subMax, S);
        const subH = 20 * S;
        let sy = cy + size * 0.72 + 22 * S;
        for (const line of subLines) {
            drawLine(c, line, cx, sy, S);
            sy += subH;
        }
        subBottom = sy;
    }
    if (s.gems) {
        // Sit well below the subtitle so names never ride on top of the gems.
        subBottom = drawGemLegend(c, cx, subBottom + 52 * S, a * smooth((t - 520) / 700));
    }
    c.restore();
    return subBottom;
}

// the objective card: label, hint, progress pips
function drawObjective(c) {
    const s = stepDef();
    if (!s || s.card) return;
    const S = US();
    const t = T() - state.stepAt;
    const cleared = state.phase === "clearing";
    const inA = smooth(t / 420);
    const outA = cleared ? 1 - smooth((T() - state.completedAt) / 620) : 1;
    const a = inA * outA;
    if (a <= 0) return;

    const maxW = Math.min(SW() * (global.mobile ? 0.94 : 0.86), 470 * S);
    const hint = typeof s.hint === "function" ? s.hint() : s.hint;
    const lines = layout(c, tokenize(hint), maxW - 36 * S, S);
    const lineH = 21 * S;
    const padX = 18 * S, padY = 14 * S;
    const labelH = 26 * S;
    const boxH = padY * 2 + labelH + lines.length * lineH + 10 * S;
    const boxW = maxW;
    const x = (SW() - boxW) / 2;
    // Desktop: below the game's spawn/status messages, which stack at
    // top-centre. Mobile: the top strip belongs to the DOM buttons and the
    // class picker, so sit in the band between the joysticks and the gem bar.
    const y = (global.mobile
        ? SH() - boxH - 152 * S
        : 78 * S) + (1 - inA) * -12;
    const cx = SW() / 2;

    c.save();
    c.globalAlpha = a;

    roundRect(c, x, y, boxW, boxH, 12 * S);
    c.fillStyle = "rgba(10,11,15,.80)";
    c.fill();
    c.lineWidth = 1.5;
    c.strokeStyle = `rgba(${GOLD},.28)`;
    c.stroke();

    // progress slider, sitting just outside the card's left edge
    const pr = cleared ? 1 : (s.progress ? clamp(s.progress(state.target), 0, 1) : 0);
    const barW = 4 * S, barX = x - barW - 7 * S;
    roundRect(c, barX, y, barW, boxH, barW / 2);
    c.fillStyle = `rgba(${GOLD},.22)`;
    c.fill();
    if (pr > 0) {
        roundRect(c, barX, y + boxH * (1 - pr), barW, boxH * pr, barW / 2);
        c.fillStyle = `rgb(${GOLD})`;
        c.fill();
    }

    // label - struck through and ticked once satisfied
    const ly = y + padY + labelH / 2;
    const done = cleared;
    const lblTxt = (typeof s.label === "function" ? s.label() : s.label) || "";
    trackedText(c, (done ? "✓  " : "") + lblTxt.toUpperCase(), cx, ly,
        16 * S, done ? `rgb(${MINT})` : `rgb(${GOLD})`, 1.6 * S, a);
    c.globalAlpha = a;

    if (s.groupLen) {
        c.font = `700 ${11 * S}px ${FONT}`;
        c.textAlign = "right";
        c.fillStyle = `rgba(${GOLD},.55)`;
        c.fillText(`${s.groupPos}/${s.groupLen}`, x + boxW - padX, ly);
    }
    let ty = y + padY + labelH + 12 * S;
    c.textBaseline = "middle";
    for (const line of lines) { drawLine(c, line, cx, ty, S); ty += lineH; }

    // step pips
    const keys = [];
    for (const s2 of STEPS) {
        if (s2.card) continue;
        const k = s2.group || s2.id;
        if (keys[keys.length - 1] !== k) keys.push(k);
    }
    const curKey = s.group || s.id;
    const total = keys.length;
    const idx = keys.indexOf(curKey);
    const gap = 13 * S;
    let dx = cx - (total - 1) * gap / 2;
    for (let i = 0; i < total; i++) {
        c.beginPath();
        c.arc(dx, y + boxH - 9 * S, (i === idx ? 3.6 : 2.4) * S, 0, Math.PI * 2);
        c.fillStyle = i === idx ? `rgb(${GOLD})`
            : i < idx ? `rgba(${GOLD},.5)` : "rgba(255,255,255,.18)";
        c.fill();
        dx += gap;
    }
    c.restore();

    // mobile stacks the card at the bottom, so the skip control goes above it
    layoutSkip(global.mobile ? y - 36 * S : y + boxH);
}

// ── controls (DOM, so they are reliably clickable/tappable) ───────────
let skipBar = null, skipAllEl = null, nextEl = null;
function ensureSkip() {
    if (skipBar) return;
    skipBar = document.createElement("div");
    skipBar.id = "dwTutSkipBar";

    const mk = (cls, text, fn) => {
        const b = document.createElement("button");
        b.className = "dwTutSkipBtn " + cls;
        b.textContent = text;
        b.tabIndex = -1;                       // never in the tab order
        b.addEventListener("mousedown", e => e.preventDefault());  // keep focus put
        b.addEventListener("click", e => {
            e.stopPropagation();
            fn();
            handBackFocus();
        });
        skipBar.appendChild(b);
        return b;
    };
    // Most objectives are cleared by DOING them - a universal Next would let
    // someone click past the thing being taught, which is how you finish a
    // tutorial having learned nothing. But some steps have nothing to do:
    // they explain a tank family, or name a number on the HUD. Those declare
    // `next: true` and get the button; everything else does not.
    nextEl = mk("dwTutNext", "Next ›", () => {
        if (state.running && state.phase === "active") completeStep();
    });
    skipAllEl = mk("dwTutSkipAll", "Skip tutorial", skipToEnd);
    document.body.appendChild(skipBar);
}
// Show the Next control only for steps that asked for one, and only once the
// step has been on screen long enough to have been read.
function showNext(on, label) {
    if (!skipBar) return;
    skipBar.classList.toggle("hasnext", !!on);
    if (on && nextEl) {
        const want = label || "Next ›";
        if (nextEl.textContent !== want) nextEl.textContent = want;
    }
}
// ── DOM spotlight + card ──────────────────────────────────────────────
// The game canvas sits underneath the DOM, so a canvas-drawn box can never
// outline a DOM button, and the settings panel (z-index 300) with its dimming
// overlay hides the canvas card entirely. Steps that point at DOM elements get
// a real DOM outline and a real DOM card, stacked above the panel and parked
// clear of it so it stays readable.
let spotEl = null, domCard = null, domCardT = null, domCardB = null;
function ensureDom() {
    if (spotEl) return;
    spotEl = document.createElement("div");
    spotEl.id = "dwTutSpot";
    document.body.appendChild(spotEl);

    domCard = document.createElement("div");
    domCard.id = "dwTutDomCard";
    domCardT = document.createElement("div");
    domCardT.className = "dwTutDomTitle";
    domCardB = document.createElement("div");
    domCardB.className = "dwTutDomBody";
    domCard.appendChild(domCardT);
    domCard.appendChild(domCardB);
    document.body.appendChild(domCard);
}
// The settings panel keeps its layout when closed and merely fades to
// opacity 0, so getBoundingClientRect still returns a real box. Without this
// the close-button outline hung around for the step's settle plus clearing
// window after the panel had visually gone.
function domVisible(el) {
    if (!el) return false;
    // Walk the ancestors ourselves rather than trusting checkVisibility alone:
    // that only treats opacity of EXACTLY 0 as hidden, so a panel one frame
    // into its fade (opacity 0.004) still counted as visible and the outline
    // flashed for a frame after it had gone.
    let n = el;
    while (n && n.nodeType === 1) {
        const cs = getComputedStyle(n);
        if (cs.display === "none" || cs.visibility === "hidden") return false;
        if (parseFloat(cs.opacity || "1") < 0.35) return false;
        n = n.parentElement;
    }
    return true;
}
function hideDomStep() {
    if (!spotEl) return;
    spotEl.classList.remove("show");
    domCard.classList.remove("show");
    if (skipBar) { skipBar.classList.remove("above"); skipBar.style.left = "50%"; }
}
// "dom"  = spotlight AND card are DOM (settings panel is covering the canvas)
// "spot" = spotlight only, the normal centred card is fine
// false  = nothing to point at
function drawDomStep(step) {
    ensureDom();
    const sel = step.ui.slice(4);
    const el = document.querySelector(sel);
    if (!el || !domVisible(el)) { hideDomStep(); return false; }
    const r = el.getBoundingClientRect();
    if (!r.width) { hideDomStep(); return false; }

    // Round to whole pixels so the outline lands on the pixel grid rather than
    // straddling it, and inherit the target's own corner radius so it hugs the
    // shape instead of squaring a rounded button.
    const pad = 6;
    const L = Math.round(r.left) - pad, T2 = Math.round(r.top) - pad;
    const W = Math.round(r.width) + pad * 2, H = Math.round(r.height) + pad * 2;
    let rad = 10;
    try {
        const cs = getComputedStyle(el);
        const got = parseFloat(cs.borderTopLeftRadius);
        if (isFinite(got)) rad = Math.min(H / 2, got > 0 ? got + pad : 8);
    } catch (e) { }
    spotEl.style.left = L + "px";
    spotEl.style.top = T2 + "px";
    spotEl.style.width = W + "px";
    spotEl.style.height = H + "px";
    spotEl.style.borderRadius = rad + "px";
    spotEl.classList.add("show");

    const panelOpen = (() => {
        const el = document.getElementById("homeSettingsPanel");
        return !!(el && el.classList.contains("open"));
    })();
    if (!panelOpen) {
        // spotlight only: the normal card is perfectly visible right now, and
        // a DOM card up here would sit on top of the class picker
        domCard.classList.remove("show");
        if (skipBar) { skipBar.classList.remove("above"); skipBar.style.left = "50%"; }
        return "spot";
    }
    domCardT.textContent = (typeof step.label === "function" ? step.label() : step.label) || "";
    // Plain text, so every marker the canvas card would have rendered as
    // chrome has to be flattened - not just the keycaps.
    domCardB.textContent = String(typeof step.hint === "function" ? step.hint() : step.hint || "")
        .replace(/\{\{KEY_([A-Z0-9_]+)\}\}/g, (m, id) => lbl("KEY_" + id))
        .replace(/\[\[([^\]]+)\]\]/g, "$1")
        .replace(/[*`]/g, "");
    domCard.classList.add("show");

    // Park the card beside the settings panel rather than on top of it.
    const panel = document.getElementById("homeSettingsPanel");
    const pr = panel && panel.classList.contains("open") ? panel.getBoundingClientRect() : null;
    const cw = domCard.offsetWidth || 300, ch = domCard.offsetHeight || 90;
    let cx, cy;
    if (pr) {
        const roomL = pr.left, roomR = window.innerWidth - pr.right;
        cx = roomL >= cw + 24 ? pr.left - cw - 16
           : roomR >= cw + 24 ? pr.right + 16
           : Math.max(8, (window.innerWidth - cw) / 2);
        cy = Math.max(8, Math.min(pr.top + 8, window.innerHeight - ch - 8));
    } else {
        cx = Math.min(Math.max(8, r.left + r.width / 2 - cw / 2), window.innerWidth - cw - 8);
        cy = Math.min(r.bottom + 14, window.innerHeight - ch - 8);
    }
    domCard.style.left = Math.round(cx) + "px";
    domCard.style.top = Math.round(cy) + "px";

    if (skipBar) {
        // follow the card rather than staying screen-centred, or the buttons
        // land in the middle of the settings panel and cover the binds
        skipBar.classList.add("above");
        skipBar.style.left = Math.round(cx + cw / 2) + "px";
        skipBar.style.top = Math.round(cy + ch + 8) + "px";
    }
    return "dom";
}

// Give the keyboard straight back to the game: the tank must keep driving.
function handBackFocus() {
    try {
        const b = document.activeElement;
        if (b && b.blur) b.blur();
        const cv = document.getElementById("gameCanvas");
        if (cv && global.gameStart) cv.focus();
    } catch (e) { }
}
// glue the bar just under (or above) the canvas-drawn card: logical -> CSS px
function layoutSkip(atY) {
    if (!skipBar) return;
    const k = window.innerHeight / Math.max(1, SH());
    const barH = skipBar.offsetHeight || 40;
    const pad = 16;
    const maxTop = window.innerHeight - barH - pad;
    const top = Math.max(pad, Math.min(maxTop, Math.round(atY * k + pad)));
    skipBar.style.top = top + "px";
}
function showSkip(on) {
    if (!skipBar) return;
    skipBar.classList.toggle("show", !!on);
}
// Back is meaningless on the very first objective, so it is not offered there.
function refreshNav() { /* no manual navigation - see makeSkipBar */ }

// Skipping still earns the send-off - ending on a blank screen feels like the
// tutorial broke rather than finished.
function skipToEnd() {
    if (!state.running) return finish();
    const i = STEPS.findIndex(s2 => s2.final);
    if (i < 0) return finish();
    enterStep(i);
}


// ── input ──────────────────────────────────────────────────────────────
function onKeyDown(e) {
    if (!state.running) return;
    const k = e.keyCode;
    if (k === 32) state.fireSeen = true;
    if (k === global.KEY_AUTO_FIRE) state.autofireCount++;
    if (k === global.KEY_OVER_RIDE) { state.overrideSeen = true; state.overrideCount++; }
    if (k === global.KEY_AUTO_ALT) state.pingSeen = true;
}
// Mobile has no key events, so catch the taps that land on the action buttons
// using the game's own hit regions (index 3 = Autofire, 7 = Override - see
// canvas.js touchStart). Auto-spin needs no such hook: it sets global.autoSpin.
function onTouchStart(e) {
    if (!state.running || !global.mobile || !global.clickables) return;
    for (const t of e.changedTouches) {
        const mpos = { x: t.clientX * global.ratio, y: t.clientY * global.ratio };
        const b = global.clickables.mobileButtons.check(mpos);
        if (b === 3) state.autofireCount++;      // Autofire
        else if (b === 7) { state.overrideSeen = true; state.overrideCount++; }  // Override
    }
}
function onMouseDown(e) {
    if (!state.running) return;
    if (e.button === 0) state.fireSeen = true;
    if (e.button === 2) state.altDown = true;
}
function onMouseUp(e) {
    if (e.button === 2) state.altDown = false;
}

// Tell the server we are mid-tutorial so gems from rocks we break are held for
// us. Re-sent periodically because respawning gives the player a fresh body,
// which would otherwise silently lose the flag.
let tutFlagAt = 0;
function sendTutorialFlag(on) {
    try { global.canvas.socket.talk("TUT", on ? 1 : 0); } catch (e) { }
}

// ── lifecycle ──────────────────────────────────────────────────────────
function open() {
    ensureSkip();
    buildChain();
    state.running = true;
    state.bursts = [];
    state.lastBreak = null;
    state.settleAt = 0;
    state.evolveCount = 0;
    state.lastType = gui.type;
    showSkip(true);
    sendTutorialFlag(true);
    tutFlagAt = T();
    enterStep(0);
}
function finish() {
    hideDomStep();
    sendTutorialFlag(false);
    try { localStorage.setItem(STORAGE_KEY, "1"); } catch (e) { }
    // Training over - hand them back to the menu, where the Play button now
    // leads to the real game (the completion flag just set means home.js no
    // longer reroutes it here). Lingering alone in a spent plot teaches
    // nothing and quietly hogs one of the few slots.
    //
    // app.js installs an onbeforeunload that asks "leave site?" whenever a
    // game is live, which is right for a real match and absurd here: the
    // learner finished, and the browser interrogates them about it. Close the
    // socket and drop the guard first so the trip home is silent.
    if (global.tutorialMode) {
        setTimeout(() => {
            try { window.onbeforeunload = null; } catch (e) { }
            try { global.canvas.socket.close(); } catch (e) { }
            global.gameStart = false;
            try { location.replace(location.pathname); } catch (e) {
                try { location.reload(); } catch (e2) { }
            }
        }, 4200);
    }
    state.running = false;
    state.phase = "finished";
    state.target = null;
    showSkip(false);
}

export function isComplete() {
    try { return localStorage.getItem(STORAGE_KEY) === "1"; } catch (e) { return false; }
}
export function startTutorial() { if (!isComplete()) open(); }
export function replayTutorial() { open(); }

ensureSkip();
let startedOnce = false;
// Called every frame from app.js right after drawGUI() - screen-space pass.
export function hook() {
    // Only ever run on the tutorial server. The proof is global.tutorialPlot,
    // which arrives in a TUTI packet that ONLY the tutorial server sends -
    // never the client-set tutorialMode flag on its own. If the tutorial
    // server is unreachable the connection falls back to the live game, and
    // trusting the client flag there would drop a beginner into a real match
    // with objective cards over it.
    if (!startedOnce && global.tutorialMode && global.tutorialPlot &&
        global.gameStart && !global.died && terr()) {
        startedOnce = true;
        open();
    }
    if (global.died || global.disconnected) {
        // the death panel owns the screen; nothing of ours floats over it
        showSkip(false);
        hideDomStep();
        return;
    }

    const c = ctxGui();
    if (!c) return;

    if (!state.running) { showSkip(false); showNext(false); hideDomStep(); return; }
    if (T() - tutFlagAt > 3000) { tutFlagAt = T(); sendTutorialFlag(true); }

    update();

    const s = stepDef();
    // Next appears only on steps that asked for one, only while the step is
    // still live, and only after a beat - so it cannot be clicked away before
    // the card it belongs to has even faded in.
    showNext(!!(s && s.next && state.phase === "active" && T() - state.stepAt > 1400),
             s && s.nextLabel);
    c.save();
    c.textBaseline = "middle";
    if (s && s.card) {
        hideDomStep();
        const cardBottom = drawTitleCard(c, s);
        // Park skip/next under the actual title + subtitle (and gem row),
        // not at a fixed fraction of the screen - that overlap on short
        // viewports and on the long "never touch a base" card.
        const S = US();
        layoutSkip((cardBottom || SH() * 0.42) + 22 * S);
        showSkip(!s.final);
        refreshNav();
    } else {
        const domMode = (s && s.ui && s.ui.indexOf("dom:") === 0) ? drawDomStep(s) : false;
        if (domMode === "dom") {
            // the settings panel is covering the canvas, so card and outline
            // are both DOM and stacked above it
            showSkip(true);
            refreshNav();
        } else {
            if (!domMode) hideDomStep();
            // highlight first so the objective card always reads on top of it
            if (s && s.ui && !domMode) drawUiHighlight(c, s.ui);
            if (s && s.id === "storm") drawStormDrillHud(c);
            drawObjective(c);   // positions the skip control under its card
            showSkip(true);
            refreshNav();
        }
    }
    c.restore();
}

document.addEventListener("keydown", onKeyDown);
document.addEventListener("mousedown", onMouseDown);
document.addEventListener("mouseup", onMouseUp);
window.addEventListener("blur", () => { state.altDown = false; });
document.addEventListener("touchstart", onTouchStart, { passive: true });

// read-only handle for debugging/automation: which objective is live and what
// it is currently pointing at
window.dwTut = state;
// QA hook: jump straight to a lesson by id (the chain is built on open()).
window.dwTutJump = (id) => {
    if (!state.running) return false;
    const i = STEPS.findIndex(st => st.id === id);
    if (i < 0) return false;
    enterStep(i);
    return true;
};
