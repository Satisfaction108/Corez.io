import { global } from "./global.js";
import { util } from "./util.js";
import { gui } from "./socketinit.js";
import { gameSound } from "./sound.js";

// ── Corez.io training ──────────────────────────────────────────────────
// Six short lessons, each one learned by doing it, then a send-off card with
// a Play button that drops you straight into a real raid:
//
//   1 Move      drive + aim
//   2 Power up  spend a few stat points (the server spends the rest)
//   3 Mine      break a marked rock, scoop up what falls out
//   4 Bank      park on the vault, deposit (carried gems drop on death)
//   5 Shop      free gems, buy one thing
//   6 Fight     beat a scripted Rookie that cannot kill you
//   ✓ Ready     the raid in three lines, Play / Back to menu
//
// The instruction card is DOM (crisp text, real buttons, theme tokens from
// home.css). World markers are canvas, drawn from drawGameplay() so they share
// the camera. Nothing here can soft-lock: every lesson has an idle hint, a
// "skip step" link once you look stuck, and a hard give-up that stages the
// outcome on the server and moves on. The server keeps its own promises too
// (tutorialSession.tickSafety: health floor while a bot is up, a fighter that
// wilts if the fight drags on).

// home.js reads the same key to decide whether to show the "new? start here"
// badge. Kept at _v1 so people who already finished are not sent back.
const STORAGE_KEY = "digRoyaleTutorialDone_v1";
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
const FONT = "Rubik, Ubuntu, sans-serif";
const DISPLAY = "'Lilita One', Rubik, Ubuntu, sans-serif";

// ── keybind labels ─────────────────────────────────────────────────────
const DEFAULTS = {
    KEY_UP: "W", KEY_DOWN: "S", KEY_LEFT: "A", KEY_RIGHT: "D",
    KEY_AUTO_FIRE: "E", KEY_AUTO_SPIN: "C", KEY_OVER_RIDE: "R",
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
const SW = () => global.screenWidth;
const SH = () => global.screenHeight;
// Screen-space canvas scale (edge arrow): tracks the viewport like the HUD.
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

// A good first rock: ore-bearing if possible, at a comfortable screen-relative
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

// The client is never told its team outright; gui.color starts with it.
function myTeam() {
    const c = String(gui.color || "");
    if (c.indexOf("blue") === 0) return -1;
    if (c.indexOf("red") === 0) return -2;
    return 0;
}

// ── server commands ────────────────────────────────────────────────────
// Only honoured by the tutorial server (TUT case in sockets.js); inert on a
// live server. Everything goes as strings so "0" never reads as truthy junk.
function tut(cmd, ...args) {
    try {
        global.canvas.socket.talk("TUT", cmd,
            ...(args.length ? args.map(a => String(a)) : [""]));
    } catch (e) { }
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
const GEM_NAMES = ["Copper", "Azurite", "Core Shard", "Emerald", "Dropped Gems"];
function nearestGem() {
    let best = null, bestD = Infinity;
    for (const e of global.entities) {
        if (!e || !e.index) continue;
        const m = global.mockups[String(e.index).split("-")[0]];
        if (!m || !GEM_NAMES.includes(m.name)) continue;
        if (!inArena(e.x, e.y)) continue;
        const d = distTo(e);
        if (d < bestD) { bestD = d; best = e; }
    }
    return best;
}
function hpFrac(e) {
    if (!e || e.health === undefined) return 1;
    const h = typeof e.health === "object" ? e.health : { amount: e.health, max: 1 };
    const max = h.max || 1;
    return clamp((h.amount != null ? h.amount : max) / max, 0, 1);
}
function shopState() { return (global.shop && global.shop.state) || {}; }
function kitTotal() {
    const k = shopState().kit || {};
    let n = 0;
    for (const id in k) n += k[id] | 0;
    return n;
}
// A cheap fingerprint of everything a purchase can change.
function ownedSig() {
    const s = shopState();
    const gear = Array.isArray(s.gear) ? s.gear.length : Object.keys(s.gear || {}).length;
    return kitTotal() + "|" + (s.drill | 0) + "|" + gear + "|" + (s.arm || "");
}
function medkitKey() {
    const ko = shopState().kitOrder || [];
    const i = ko.indexOf("medkit");
    return i < 0 ? null : ["KEY_KIT_1", "KEY_KIT_2", "KEY_KIT_3"][i] || "KEY_KIT_1";
}
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
    phase: "idle",        // idle | active | clearing | final | finished
    target: null,         // {kind:'rock'|'gem'|'foe'|'pad'|'self', x, y, ...}
    base: {},             // per-step baseline
    sub: 0,               // sub-phase inside a step (mine: rock then gems)
    subAt: 0,
    bursts: [],
    aimTotal: 0,
    aimLast: null,
    lockedRock: null,
    lastBreak: null,
    fighterSeen: false,
    fighterAskAt: 0,
    bankPeak: 0,
    lastProg: 0,
    lastProgAt: 0,
    hint: false,
    edge: null,
};

function snapshot() {
    state.base = {
        x: px(), y: py(),
        carried: global.gems.carried | 0,
        banked: global.gems.banked | 0,
        points: gui.points | 0,
        owned: ownedSig(),
    };
    state.aimTotal = 0;
    state.aimLast = null;
}

// ── the lessons ────────────────────────────────────────────────────────
// Card text markup: {{KEY_X}} bound keycap, [[x]] literal keycap, *bold*.
// title/text/hint may be functions (they re-render when their output changes).
//   target()   world marker for this frame, or null
//   progress() 0..1, drives the bar and the idle-hint timer
//   done()     true = lesson complete
//   giveUp     ms before we stage the outcome ourselves and move on
//   fallback() what "staging the outcome" means for this lesson
const mob = () => !!global.mobile;
const STEPS = [
    {
        id: "move", dot: "Move", allow: "",
        title: "Take it for a spin",
        text: () => mob()
            ? "Left stick drives. Right stick aims and shoots."
            : "Drive with {{KEY_UP}} {{KEY_LEFT}} {{KEY_DOWN}} {{KEY_RIGHT}}. Your gun follows the mouse.",
        hint: () => mob()
            ? "Push the left stick any direction and roll around a bit."
            : "Hold {{KEY_UP}} and swing your mouse in a circle.",
        praise: "Smooth.",
        target: () => ({ kind: "self" }),
        progress: () => {
            const d = Math.hypot(px() - state.base.x, py() - state.base.y);
            const moved = clamp(d / 320, 0, 1);
            // Phones aim with the right stick, which also swings the target.
            const aimed = clamp(aimSweep() / (Math.PI * 2), 0, 1);
            return moved * 0.5 + aimed * 0.5;
        },
        done: (p) => p >= 1,
        giveUp: 45000,
    },
    {
        id: "stats", dot: "Power up", allow: "stats", ui: "skills",
        title: "Power up",
        text: () => mob()
            ? "You've got points to spend. Tap the stat buttons."
            : "You've got points to spend. Press [[1]] to [[0]], or click the bars in the bottom left.",
        hint: () => "*Mining Power* is a great first pick. Rock breaks way faster.",
        praise: "Stronger already.",
        onEnter: () => { if ((gui.points | 0) < 4) tut("points", 12); },
        progress: () => clamp(spentPoints() / 3, 0, 1),
        done: () => spentPoints() >= 3 || (state.base.points > 0 && (gui.points | 0) <= 0),
        onDone: () => tut("spendrest"),
        fallback: () => tut("spendrest"),
        giveUp: 50000,
    },
    {
        id: "mine", dot: "Mine", allow: "",
        // sub 0: break the marked rock.  sub 1: pick up what fell out.
        title: () => state.sub === 0 ? "Break that rock" : "Grab the gems",
        text: () => state.sub === 0
            ? (mob() ? "Aim the right stick at the glowing rock and keep shooting."
                     : "Shoot the glowing rock. Hold [[Click]], or tap {{KEY_AUTO_FIRE}} to fire nonstop.")
            : "Drive over them. They go straight into your satchel.",
        hint: () => state.sub === 0
            ? (distTo(state.target) > 700 ? "Follow the arrow. It's just over there."
                : "Better ore takes more hits. Keep going.")
            : "Gems fade if you leave them lying around too long.",
        praise: "Cha-ching.",
        onEnter: () => { state.lockedRock = null; state.lastBreak = null; },
        target: () => {
            if (state.sub === 0) {
                const t = terr();
                if (state.lockedRock && rockAlive(t, state.lockedRock.k)) return state.lockedRock;
                if (state.lockedRock) return state.lockedRock;   // just died; done() handles it
                const r = acquireRock(true);
                if (r) {
                    state.lockedRock = { kind: "rock", ...r };
                    // Too far to see? Glide over so the rock and the marker
                    // land on screen together.
                    const dx = px() - r.x, dy = py() - r.y, d = Math.hypot(dx, dy) || 1;
                    if (d > 700) tut("gotoxy", r.x + dx / d * 260, r.y + dy / d * 260);
                }
                return state.lockedRock;
            }
            const g = nearestGem();
            if (g) return { kind: "gem", x: g.x, y: g.y };
            return state.lastBreak ? { kind: "gem", x: state.lastBreak.x, y: state.lastBreak.y, ghost: true } : null;
        },
        progress: () => {
            if (state.sub === 1) return 0.6 + 0.4 * clamp((global.gems.carried - state.base.carried) / 30, 0, 1);
            const t = terr(), tg = state.lockedRock;
            if (!t || !tg) return 0;
            if (!rockAlive(t, tg.k)) return 0.6;
            const h = t._rockHealth.get(tg.k);
            return h === undefined ? 0 : clamp(1 - h, 0, 1) * 0.6;
        },
        done: () => {
            if (state.sub === 0) {
                const t = terr(), tg = state.lockedRock;
                // No rock anywhere after a few seconds: hand over some gems.
                if (!tg && T() - state.stepAt > 5000) { stepFallback(); return false; }
                if (tg && t && !rockAlive(t, tg.k)) {
                    state.lastBreak = { x: tg.x, y: tg.y };
                    burst(tg.x, tg.y, GOLD);
                    sfxAdvance();
                    setSub(1);
                }
                return false;
            }
            if ((global.gems.carried | 0) > state.base.carried) return true;
            // The rock had nothing in it, or the gems vanished before pickup.
            if (T() - state.subAt > 6000 && !nearestGem()) {
                tut("gems", state.base.carried + 90);
                state.base.carried = -1;
            }
            return false;
        },
        fallback: () => tut("gems", Math.max((global.gems.carried | 0) + 90, 120)),
        giveUp: 80000,
    },
    {
        id: "bank", dot: "Bank", allow: "bank",
        title: () => global.vault.onPad ? "Hit Deposit" : "Bank your gems",
        text: () => global.vault.onPad
            ? "Stay on the pad until the bar fills. Getting shot stops it."
            : "Carried gems drop when you die. Park on the vault to keep them safe.",
        hint: () => global.vault.onPad
            ? "Press the *Deposit* button in the panel below."
            : "The vault is the big rainbow pad. Follow the arrow.",
        praise: "Safe and sound.",
        onEnter: () => {
            // The vault panel refuses anything under 15.
            if ((global.gems.carried | 0) < 15) tut("gems", 120);
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
        id: "shop", dot: "Shop", allow: "shop",
        title: () => global.shop.onPad ? "Buy something" : "Go shopping",
        text: () => global.shop.onPad
            ? "A *Medkit* is a solid first pick. Click it, then hit *Buy*."
            : "Here's *1,000 gems* on the house. Roll onto the shop pad.",
        hint: () => global.shop.onPad
            ? (global.shop.dismissed ? "Closed it? Step off the pad and back on." : "Kit items are in the *Kit* tab.")
            : "The shop is the teal pad. Follow the arrow.",
        praise: "Nice buy.",
        onEnter: () => {
            global.shop.dismissed = false;
            tut("banked", (global.gems.banked | 0) + 1000);
            state.bankPeak = global.gems.banked | 0;
            const p = shopPad();
            if (!p || distTo(p) > 900) tut("goto", "shop");
        },
        target: () => global.shop.onPad ? null : shopPad(),
        progress: () => global.shop.onPad ? 0.5 : clamp(0.45 - distTo(shopPad()) / 5000, 0, 0.45),
        done: () => {
            state.bankPeak = Math.max(state.bankPeak, global.gems.banked | 0);
            return ownedSig() !== state.base.owned ||
                (global.gems.banked | 0) < state.bankPeak - 100;
        },
        fallback: () => tut("kit", "medkit"),
        giveUp: 90000,
    },
    {
        id: "fight", dot: "Fight", allow: "kit",
        title: "Beat the Rookie",
        text: () => {
            const k = medkitKey();
            if (!mob() && k && hpFrac(me()) < 0.45) return `Low on health? Press {{${k}}} to use your Medkit.`;
            return "Keep moving and keep shooting. Relax, it can't kill you.";
        },
        hint: () => mob()
            ? "Circle around it so its shots miss you."
            : "Circle around it so its shots miss. {{KEY_AUTO_FIRE}} toggles auto-fire.",
        praise: "Winner!",
        onEnter: () => {
            state.fighterSeen = false;
            state.fighterAskAt = T() + 700;
            global.shop.dismissed = true;          // walk away from the shop panel
            tut("clear");
            tut("heal");
            tut("goto", "clearing");
        },
        target: () => {
            const b = practiceBot("Rookie");
            return b ? { kind: "foe", x: b.x, y: b.y } : null;
        },
        progress: () => {
            const b = practiceBot("Rookie");
            if (!b) return state.fighterSeen ? 1 : 0;
            return clamp(1 - hpFrac(b), 0, 1);
        },
        done: () => {
            const b = practiceBot("Rookie");
            if (b) state.fighterSeen = true;
            // Ask (and keep asking) until the bot is actually up.
            if (!state.fighterSeen && T() > state.fighterAskAt) {
                tut("fighter");
                state.fighterAskAt = T() + 3500;
            }
            return state.fighterSeen && !b;
        },
        settle: 350,
        fallback: () => tut("clear"),
        giveUp: 120000,
    },
];
const FINAL_INDEX = STEPS.length;

function spentPoints() { return Math.max(0, state.base.points - (gui.points | 0)); }
function stepDef() { return STEPS[state.step]; }
function setSub(n) {
    state.sub = n;
    state.subAt = T();
    state.base.carried = global.gems.carried | 0;
    state.lastProgAt = T();
    state.hint = false;
}

// ── step machine ───────────────────────────────────────────────────────
function applyAllow(allow, ui) {
    // Mirrored on window so the HUD hides controls the lesson has locked (see
    // drawSkillBars / drawKitBox in app.js). A step that says nothing is
    // locked down rather than inheriting the previous step's permissions.
    window.dwTutAllow = allow || "";
    window.dwTutUi = ui || "";
    tut("allow", allow || "");
}

function enterStep(i) {
    if (i >= FINAL_INDEX) return enterFinal();
    state.step = i;
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
    const s = stepDef();
    applyAllow(s.allow, s.ui);
    if (s.onEnter) { try { s.onEnter(); } catch (e) { } }
    ui.showStep(s, i);
    sfxAdvance();
}

function completeStep() {
    const s = stepDef();
    if (!s || state.phase !== "active") return;
    state.phase = "clearing";
    state.completedAt = T();
    if (s.onDone) { try { s.onDone(); } catch (e) { } }
    sfxObjective();
    const tg = state.target;
    if (tg && tg.kind !== "self" && tg.kind !== "pad") burst(tg.x, tg.y, tg.kind === "gem" ? EMERALD : GOLD);
    else burst(px(), py(), GOLD);
    ui.celebrate(s, state.step);
}

// Stage the lesson's outcome ourselves, then count it done.
function stepFallback() {
    const s = stepDef();
    if (!s || state.phase !== "active") return;
    if (s.fallback) { try { s.fallback(); } catch (e) { } }
    completeStep();
}

function enterFinal() {
    state.phase = "final";
    state.step = FINAL_INDEX;
    state.target = null;
    applyAllow("", "");
    tut("clear");
    tut("heal");
    // Count it as done the moment you see the send-off, even if the tab is
    // closed from here: they have seen the whole loop (or chose to skip it).
    try { localStorage.setItem(STORAGE_KEY, "1"); } catch (e) { }
    ui.showFinal();
    sfxFinale();
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

function update() {
    const s = stepDef();
    if (!s || state.phase === "final") return;

    if (state.phase === "active") {
        state.target = s.target ? s.target() : null;
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
        if (T() - state.completedAt > 1100) enterStep(state.step + 1);
    }
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

    const sp = w2s(tg.x, tg.y, camX, camY, ratio);
    const onScreen = sp.x > -40 && sp.x < SW() + 40 && sp.y > -40 && sp.y < SH() + 40;
    state.screen = { x: sp.x, y: sp.y, on: onScreen };
    if (!onScreen) {
        // drawn in the late pass so no GUI covers it
        state.edge = { sp, tg, fade, at: now };
        return;
    }
    c.save();
    c.globalAlpha = fade;
    let top = sp.y - 40;
    if (tg.kind === "rock") top = drawRockTarget(c, tg, camX, camY, ratio);
    else if (tg.kind === "pad") top = drawPadTarget(c, tg, sp, ratio);
    else top = drawPointTarget(c, tg, sp, ratio);
    drawPointer(c, sp.x, top - 14);
    c.restore();
    drawTrail(c, sp, fade, tg.kind === "foe" ? FOE : GOLD);
}

function drawSelfRing(c, ratio, fade) {
    const s = stepDef();
    const pr = s && s.progress && state.phase === "active" ? clamp(s.progress(), 0, 1) : 1;
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

// Vault / shop pad: a slow rotating dashed ring sized to the pad.
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

// Gems and the Rookie: two expanding ripples in the target's colour.
function drawPointTarget(c, tg, sp, ratio) {
    const now = T();
    const col = tg.kind === "foe" ? FOE : EMERALD;
    const base = (tg.kind === "foe" ? 44 : 20) * Math.max(0.6, ratio);
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
    const col = e.tg.kind === "foe" ? FOE : GOLD;
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

// Drawn from the very end of the frame so no GUI element can cover it.
export function drawIndicators() {
    if (!state.running || global.died || global.disconnected) return;
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

const ICONS = {
    storm: '<svg viewBox="0 0 40 40"><circle cx="20" cy="20" r="15" fill="#9b78e0" stroke="#0c0a0e" stroke-width="3.5"/><circle cx="20" cy="20" r="7" fill="#2b2533" stroke="#0c0a0e" stroke-width="3"/><path d="M8 13 A15 15 0 0 1 27 6" fill="none" stroke="#e5d8ff" stroke-width="3" stroke-linecap="round"/></svg>',
    gem: '<svg viewBox="0 0 40 40"><path d="M11 6h18l7 9-16 20L4 15z" fill="#3fcf7a" stroke="#0c0a0e" stroke-width="3.5" stroke-linejoin="round"/><path d="M4 15h32M15 6l5 29M25 6l-5 29" fill="none" stroke="#1d7a44" stroke-width="2"/><path d="M13 9l-4 5" stroke="#d7ffe6" stroke-width="3" stroke-linecap="round"/></svg>',
    crown: '<svg viewBox="0 0 40 40"><path d="M5 30 3 11l10 8 7-12 7 12 10-8-2 19z" fill="#f2b83c" stroke="#0c0a0e" stroke-width="3.5" stroke-linejoin="round"/><rect x="5" y="30" width="30" height="5" rx="1.5" fill="#a8750f" stroke="#0c0a0e" stroke-width="3"/></svg>',
};

const ui = {
    root: null, card: null, eyebrow: null, dots: null, title: null, text: null,
    bar: null, fill: null, hint: null, hintText: null, stuckBtn: null, stamp: null,
    endWrap: null,
    last: {},
    build() {
        if (this.root) return;
        const root = document.createElement("div");
        root.id = "dwTut";
        root.innerHTML =
            '<div class="dwt-card">' +
              '<div class="dwt-top">' +
                '<span class="dwt-eyebrow"></span>' +
                '<span class="dwt-dots"></span>' +
                '<button class="dwt-skip" type="button">Skip tutorial</button>' +
              '</div>' +
              '<div class="dwt-title"></div>' +
              '<div class="dwt-text"></div>' +
              '<div class="dwt-bar"><i></i></div>' +
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
        this.fill = root.querySelector(".dwt-bar i");
        this.hint = root.querySelector(".dwt-hint");
        this.hintText = root.querySelector(".dwt-hint-text");
        this.stuckBtn = root.querySelector(".dwt-stuck");
        this.stamp = root.querySelector(".dwt-stamp");
        for (let i = 0; i < STEPS.length; i++) {
            const d = document.createElement("i");
            d.title = STEPS[i].dot;
            this.dots.appendChild(d);
        }
        const guard = (b, fn) => {
            b.tabIndex = -1;
            b.addEventListener("mousedown", e => e.preventDefault());
            b.addEventListener("click", e => { e.stopPropagation(); fn(); handBackFocus(); });
        };
        guard(root.querySelector(".dwt-skip"), () => { if (state.running && state.phase !== "final") enterFinal(); });
        guard(this.stuckBtn, () => stepFallback());

        const end = document.createElement("div");
        end.id = "dwTutEnd";
        end.innerHTML =
            '<div class="dwt-end-card">' +
              '<div class="dwt-end-badge">Training complete</div>' +
              '<div class="dwt-end-title">You\'re ready!</div>' +
              '<div class="dwt-end-sub">That\'s the whole loop. Here\'s how a real raid plays out:</div>' +
              '<ul class="dwt-end-list">' +
                `<li>${ICONS.storm}<span>Raids run <b>2 hours</b> and a <b>storm</b> keeps closing in. Stay inside it.</span></li>` +
                `<li>${ICONS.gem}<span>Mine, <b>bank often</b>, and spend at shops to get stronger.</span></li>` +
                `<li>${ICONS.crown}<span><b>Last one standing wins.</b> The top 10 all get paid.</span></li>` +
              '</ul>' +
              '<button class="dwt-play" type="button"><b>Play</b></button>' +
              '<button class="dwt-menu" type="button">Back to menu</button>' +
              '<div class="dwt-end-foot">Sign in from the menu to play ranked and earn gemdust.</div>' +
            '</div>';
        document.body.appendChild(end);
        this.endWrap = end;
        end.querySelector(".dwt-play").addEventListener("click", () => finish(true));
        end.querySelector(".dwt-menu").addEventListener("click", () => finish(false));
    },
    // Size in lockstep with the game's UI Scale setting, and never wider or
    // taller than a phone can afford.
    layout() {
        const scale = { 2560: 0.9, 1920: 1, 1536: 1.12, 1280: 1.05 }[global.UIscale] || 1;
        const vw = window.innerWidth, vh = window.innerHeight;
        const short = vh < 480;
        const fit = Math.min(1, vw / 640, vh / (short ? 600 : 560));
        const s = clamp(scale * fit, 0.58, 1.25);
        this.root.classList.toggle("short", short);
        document.documentElement.style.setProperty("--dwt-s", s.toFixed(3));
        const mobile = !!global.mobile;
        this.root.classList.toggle("mobile", mobile);
        // The shop panel opens over the middle of the screen with its header
        // near the top: shrink to one line so it never sits on the tabs.
        this.root.classList.toggle("compact", !!(global.shop && global.shop.onPad && !global.shop.dismissed));
    },
    showStep(s, i) {
        this.build();
        this.last = {};
        this.card.classList.remove("done", "enter");
        void this.card.offsetWidth;          // restart the entrance animation
        this.card.classList.add("enter");
        this.root.classList.add("show");
        this.eyebrow.textContent = `Training · ${i + 1} of ${STEPS.length}`;
        const dots = this.dots.children;
        for (let k = 0; k < dots.length; k++) {
            dots[k].className = k < i ? "on" : k === i ? "cur" : "";
        }
        this.stamp.textContent = "";
        this.hint.classList.remove("show", "stuck");
        this.card.classList.remove("hinting");
        this.fill.style.width = "0%";
        this.render(s);
    },
    render(s) {
        const t = val(s.title), x = val(s.text);
        if (t !== this.last.t) { this.title.textContent = t; this.last.t = t; }
        if (x !== this.last.x) { this.text.innerHTML = markup(x); this.last.x = x; }
    },
    tick(s, p, stuck) {
        this.layout();
        this.render(s);
        const w = Math.round(p * 100) + "%";
        if (this.fill.style.width !== w) this.fill.style.width = w;
        if (state.hint) {
            const h = val(s.hint) || "";
            if (h !== this.last.h) { this.hintText.innerHTML = markup(h); this.last.h = h; }
            this.hint.classList.add("show");
            this.card.classList.add("hinting");
        } else { this.hint.classList.remove("show"); this.card.classList.remove("hinting"); }
        this.hint.classList.toggle("stuck", !!stuck);
    },
    celebrate(s, i) {
        this.card.classList.add("done");
        this.fill.style.width = "100%";
        this.hint.classList.remove("show");
        this.card.classList.remove("hinting");
        this.stamp.textContent = s.praise || "Nice!";
        const d = this.dots.children[i];
        if (d) d.className = "on pop";
    },
    showFinal() {
        this.build();
        this.root.classList.remove("show");
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
    ui.build();
    state.running = true;
    state.bursts = [];
    sendTutorialFlag(true);
    tutFlagAt = T();
    // Fresh plot: landmarks, no leftover bots, base neutral, one tank only.
    tut("hello");
    tut("clear");
    tut("reset");
    tut("heal");
    tut("lock", "none");
    enterStep(0);
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
    if (T() - tutFlagAt > 3000) { tutFlagAt = T(); sendTutorialFlag(true); }
    update();
}

// read-only handle for debugging/automation
window.dwTut = state;
// QA hooks: jump straight to a lesson by id, or to the send-off.
window.dwTutJump = (id) => {
    if (!state.running) return false;
    if (id === "ready") { enterFinal(); return true; }
    const i = STEPS.findIndex(st => st.id === id);
    if (i < 0) return false;
    enterStep(i);
    return true;
};
