// Raid heat, the client half: the hunted marks, the Core, the drop-in
// landings, the Rattler and the first-bank moment. The server sends the
// state in RY (hunt, core, you.hunt), the moments as KC callouts and FX
// bursts; juice.js does the shaking and glitching.
//
//   hunted     red marks on the minimap and big map, edge arrows to hunted
//              tanks within ~1.5 screens (the top target a bit further), a
//              badge over the tank. When it's you: YOU'RE HUNTED, a red
//              vignette on the heartbeat, a heartbeat that speeds up when an
//              enemy is close and pointing its gun at you, a HUNTED badge
//              with the hunter count in the stack under the clock (app.js
//              hudNotes), then SAFE when you bank.
//   core       drawn here (a crystal heart that cracks as it loses health),
//              a bar under the clock, a floor glow and its shockwave ring,
//              the pulses, the shards, the big break
//   sky drop   skyDrop.js draws the fall; the FX and the camera hooks pass through here
//   moments    kills (ELIMINATED with a combo count, shatter in their colour),
//              hits (sparks), banking (gems streaming in, the counter rolling
//              up, confetti on a big one), the storm closing, a boss
//              surfacing, the Core cracking the ground open and its break,
//              low health (glitches, colour split, a cracked screen), a lock
//              reticle when an enemy aims at a hunted you
//   calm HUD   global.hudCalm: a new player (coach on) who hasn't banked yet
//              sees fewer cards
//
// app.js passes its HUD helpers through init and calls the draw hooks; the
// socket handlers call onRY / onKC / onFX.
import { global } from "./global.js";
import { config } from "./config.js";
import { gui } from "./socketinit.js";
import { gameSound } from "./sound.js";
import * as juice from "./juice.js";
import * as JM from "./juiceMath.js";
import * as skyDrop from "./skyDrop.js";

let A = null;
export function init(helpers) { A = helpers; juice.init(helpers); skyDrop.init(helpers); }
export const fallOf = (id) => skyDrop.fallOf(id);
// a supply crate's chest is drawn emerald (app.js drawChestBoulder)
const CRATE_KIND = { epic: true, emerald: true };
export function crateKind(id) { return S.crateIds.has(id) ? CRATE_KIND : null; }
export const camZoom = (ratio) => skyDrop.camZoom(ratio);
export const camOffset = () => skyDrop.camOffset();
export const inputHeld = () => skyDrop.inputHeld();
export const landAt = () => skyDrop.landAt();

const TAU = Math.PI * 2;
const RED = "#ff3b4e", RED_RGB = "255,40,60";
const CORE = "#5ce8ff", CORE_RGB = "92,232,255";
const CORE_HOT = "#ff5ad8";
const GOLD = "#f2b83c";
const EMERALD = "#3fcf7a";
const ORANGE = "#ff8a3a";
const PULSE_R = 620;               // coreFinale.js PULSE_R
const SHARD_MS = 650;              // coreFinale.js SHARD_FLIGHT_MS (the FX carries it)
const calm = () => !!(global.reducedMotion && global.reducedMotion());
const lite = () => !!config.graphical.fewerEffects;
const clamp = (v, a = 0, b = 1) => v < a ? a : v > b ? b : v;
const near = (x, y, d) => Math.hypot(x - global.player.renderx, y - global.player.rendery) < d;

const S = {
    huntSrc: null, huntById: new Map(), mine: 0, hunters: 0,
    threat: 0, threatAt: 0, lowHp: 0, me: null,
    core: null, coreSeen: 0, coreCracks: null, coreCrackId: -1, coreLastHp: 1, coreHitAt: 0,
    chargeAt: -1e9, chargeMs: 900, chargePulse: false,
    downAt: 0, downX: 0, downY: 0,
    safeAt: 0, huntedAt: 0, coreUpAt: 0,
    raidId: 0, banked: 0, depStart: -1, doneAt: 0, firstBank: false,
    combo: 0, comboAt: -1e9, ryCount: 0, meteorN: 0, crateSrc: null, crateIds: new Set(), supplyPingAt: -1e9, supplyX: 0, supplyY: 0, supplyZ: 72, bossSeen: 0, bossUpAt: -1e9, bossX: 0, bossY: 0,
    stormCycle: -1, stormRaid: 0, cdLast: 0, lightningAt: 0,
    lockAim: false, lockFrom: 0, hitAt: -1e9, hitAng: 0, hitSet: 0, foeAng: NaN, depTickAt: 0, depRingAt: 0, beamsAt: -1e9, coreX: 0, coreY: 0,
};
const groundCracks = JM.crackPaths(77, 14, 6, 1);
// hit cracks: a few short sets, picked per hit (made once)
const hitCracks = [JM.crackPaths(913, 4, 3, 1), JM.crackPaths(331, 5, 3, 1), JM.crackPaths(577, 4, 4, 1), JM.crackPaths(149, 5, 3, 1)];
// fixed pools for the short-lived world bits
const mk = (n, f) => { const a = []; for (let i = 0; i < n; i++) a.push(f()); return a; };
const pulses = mk(4, () => ({ born: -1e9, x: 0, y: 0 }));
const shards = mk(10, () => ({ born: -1e9, x: 0, y: 0, fx: 0, fy: 0, hit: false, ms: SHARD_MS }));
let pulseI = 0, shardI = 0;
const ring = (x, y, col, r0, r1, dur, w) => juice.ring(x, y, col, r0, r1, dur, w);

// ── packets ────────────────────────────────────────────────────────────
export function onRY(r) {
    if (r.hunt !== S.huntSrc) {
        S.huntSrc = r.hunt;
        S.huntById.clear();
        if (r.hunt) for (const h of r.hunt) S.huntById.set(h.e, h);
    }
    const yh = r.you && r.you.hunt;
    S.mine = yh ? yh.l | 0 : 0;
    S.hunters = yh ? yh.n | 0 : 0;
    S.core = r.core || null;
    if (r.chests !== S.crateSrc) {
        S.crateSrc = r.chests;
        S.crateIds.clear();
        if (r.chests) for (const ch of r.chests) if (ch.sd && ch.e != null) S.crateIds.add(ch.e);
    }
    if ((r.raidId | 0) !== S.raidId) { S.raidId = r.raidId | 0; S.firstBank = false; S.depStart = -1; S.stormCycle = -1; }
    const now = performance.now();
    // the first packets after joining describe a raid already going: no news
    const fresh = ++S.ryCount <= 2;
    // a boss surfacing: its name slammed in, a rumble, a ping on the map
    const b = r.boss;
    if (b && b.id !== S.bossSeen) {
        S.bossSeen = b.id; S.bossUpAt = fresh ? -1e9 : now; S.bossX = b.x; S.bossY = b.y;
        if (!global.died && !fresh) {
            juice.slam(String(b.name || "BOSS").toUpperCase(), "has surfaced. " + fmt(b.gems | 0) + " gems to whoever ends it.", b.c || "#c9a8ff", 2800, 50);
            juice.glitch(0.8, 420, true);
            juice.rumble(900, 8);
            juice.lightLeak("201,168,255", 1300);
        }
    } else if (!b) S.bossSeen = 0;
    if (b) { S.bossX = b.x; S.bossY = b.y; }
    // the storm starting to close: a glitch banner (not on joining mid-cycle)
    const st = r.storm;
    if (st && st.a) {
        const c = st.c | 0;
        if (S.stormCycle >= 0 && c !== S.stormCycle && !global.died && !r.ending) {
            juice.slam(st.fin ? "LAST STORM" : "STORM CLOSING", st.fin ? "It closes all the way. Get to the middle." : "Stay inside the circle.", "#b98bff", 2600, 56);
            juice.glitch(0.9, 520);
            juice.rumble(700, 6);
            juice.flash("#b98bff", 260, 0.2);
        }
        S.stormCycle = c;
    }
}

// true = handled here (no plate in the callout queue)
export function onKC(m) {
    const kind = m[0], text = String(m[1] || ""), sub = typeof m[3] === "string" ? m[3] : "";
    const now = performance.now();
    switch (kind) {
        case "hunted":
            S.huntedAt = now;
            juice.slam(text, sub, RED, 2600, 58);
            juice.shake(34, 420);
            juice.glitch(0.85, 420);
            sfx("alarm");
            return true;
        case "toptarget":
            S.huntedAt = now;
            juice.slam(text, sub, RED, 2800, 62);
            juice.shake(40, 480);
            juice.glitch(1, 520);
            sfx("alarm");
            return true;
        case "safe":
            S.safeAt = now;
            juice.slam(text, sub, EMERALD, 1700, 60);
            sfx("relief");
            return true;
        case "core":
            S.coreUpAt = now;
            juice.slam(text, sub, CORE, 4200, 50);
            juice.shake(44, 700);
            juice.rumble(1800, 9);
            juice.glitch(1, 700, true);
            juice.flash("#bff8ff", 300, 0.35);
            juice.lightLeak(CORE_RGB, 2200);
            sfx("core");
            return true;
        case "coredown":
            juice.slam(text, sub, GOLD, 3200, 52);
            juice.glitch(0.8, 500);
            return true;
        case "corepay": {
            // your share of the Core, banked: the number rolls up
            const n = +String(text).replace(/[^0-9]/g, "") || 0;
            juice.slamRoll("BANKED +", 0, n, sub, GOLD, 3200, 62, fmt);
            juice.lightLeak("242,184,60", 1400);
            sfx("win");
            return true;
        }
        case "corebreak":
            juice.slam(text, (m[2] | 0) ? "+" + fmt(m[2] | 0) + " pts. " + sub : sub, GOLD, 3800, 56);
            juice.hitStop(50);
            juice.glitch(1, 600, true);
            sfx("win");
            return true;
        case "kill": {
            // ELIMINATED, with the streak count when kills come close together
            S.combo = JM.comboAfter(S.combo, S.comboAt, now);
            S.comboAt = now;
            const who = text.indexOf(": ") >= 0 ? text.slice(text.indexOf(": ") + 2) : "";
            const label = JM.comboLabel(S.combo);
            const pts = m[2] | 0;
            juice.slam(label ? "ELIMINATED " + label : "ELIMINATED", (who ? who : "") + (pts ? (who ? "  ·  " : "") + "+" + fmt(pts) + " pts" : ""), S.combo >= 3 ? "#ff7a6b" : S.combo >= 2 ? "#ffd76e" : "#ffffff", 2000, S.combo >= 2 ? 72 : 66);
            juice.glitch(0.4 + 0.15 * Math.min(3, S.combo), 260);
            if (S.combo >= 2) juice.hitStop(30 + 10 * Math.min(3, S.combo));
            return true;
        }
        case "huntkill":
            juice.hitStop(45);
            juice.glitch(0.55, 300);
            juice.shake(30, 340);
            return false;
        case "shutdown": case "revenge":
            juice.hitStop(40);
            return false;
        case "rattler":
            juice.glitch(0.5, 300);
            juice.shake(20, 300);
            sfx("alarm");
            return false;
        case "escaped":
            sfx("relief");
            return false;
    }
    return false;
}

// true = handled here (not pushed into global.fx)
export function onFX(kind, x, y, extra, extra2, extra3, extra4) {
    const now = performance.now();
    switch (kind) {
        case "coreup":
            S.beamsAt = now; S.coreX = x; S.coreY = y;
            ring(x, y, CORE, 40, 900, 1100, 14);
            ring(x, y, "#ffffff", 60, 1400, 1600, 20);
            ring(x, y, "#ffffff", 20, 600, 800, 8);
            juice.sparks(x, y, 40, 520, 1100, 2, CORE, TAU, 0, 9);
            juice.sparks(x, y, 30, 380, 900, 1, "#2b2433", TAU, 0, 8);
            return true;
        case "corewarn":
            ring(x, y, CORE, 30, 420, 900, 6);
            // the ground starts to shake, and keeps on until it surfaces
            juice.rumble(near(x, y, 2200) ? 30000 : 12000, near(x, y, 1800) ? 3 : 1.5);
            if (near(x, y, 1800)) juice.shake(14, 400);
            return true;
        case "corepulse": {
            const p = pulses[pulseI]; pulseI = (pulseI + 1) % pulses.length;
            p.born = now; p.x = x; p.y = y;
            juice.sparks(x, y, 22, PULSE_R * 0.9, 650, 1, "#2b2433", TAU, 0, 7);
            if (near(x, y, 950)) { juice.shake(26, 360); juice.glitch(0.45, 220); }
            try { if (gameSound.rockBreak) gameSound.rockBreak(x, y); } catch (e) { /* */ }
            return true;
        }
        case "coreshard": {
            const c = S.core;
            const s = shards[shardI]; shardI = (shardI + 1) % shards.length;
            s.born = now; s.x = x; s.y = y; s.hit = false; s.ms = (extra | 0) > 0 ? extra | 0 : SHARD_MS;
            s.fx = c ? c.x : x; s.fy = c ? c.y : y;
            return true;
        }
        case "corecharge":
            // the Core winding up an attack: extra = ms until it goes, extra2 1 = shockwave
            S.chargeAt = now; S.chargeMs = Math.max(200, extra | 0); S.chargePulse = (extra2 | 0) === 1;
            if (near(x, y, 1200)) { try { if (gameSound.uiClick) gameSound.uiClick(); } catch (e) { /* */ } }
            return true;
        case "coredead":
            S.downAt = now; S.downX = x; S.downY = y;
            ring(x, y, "#ffffff", 30, 1300, 1200, 18);
            ring(x, y, CORE, 30, 1000, 1500, 12);
            ring(x, y, GOLD, 30, 700, 1700, 8);
            juice.sparks(x, y, 70, 900, 1500, 2, CORE, TAU, 0, 11);
            juice.sparks(x, y, 50, 700, 1400, 3, GOLD, TAU, 0, 6);
            juice.sparks(x, y, 40, 520, 1200, 1, "#2b2433", TAU, 0, 10);
            ring(x, y, "#ffffff", 60, 1800, 1900, 26);
            juice.sparks(x, y, 40, 1100, 1800, 4, null, TAU, 0, 7);
            if (near(x, y, 1600)) {
                // the big one: time slows, a white-out, light everywhere
                juice.slowMo(900, 0.3);
                juice.hitStop(110, 120);
                juice.shake(46, 900);
                juice.glitch(1, 700);
                juice.flash("#ffffff", 750, 0.85);
                juice.lightLeak("255,240,200", 2200);
            }
            sfx("core");
            return true;
        case "dropin":
            skyDrop.start(x, y, extra | 0, extra2 | 0, extra3 | 0, (extra4 | 0) === 1);
            return true;
        case "supplysoon":
            // a supply drop on its way: a ping on the map, a ring where it lands
            S.supplyPingAt = now; S.supplyX = x; S.supplyY = y; S.supplyZ = (extra2 | 0) || 72;
            ring(x, y, GOLD, 40, 420, 1100, 10);
            try { if (gameSound.uiClick) gameSound.uiClick(); } catch (e) { /* */ }
            return true;
        case "supplyfall":
            // 170: supplyDrops.js SMASH_R; extra2 the crate's size
            skyDrop.start(x, y, -7, 170, extra | 0, true, 'crate', (extra2 | 0) || S.supplyZ);
            return true;
        case "meteorfall":
            // one rock of a meteor shower on its way down (raidEvents.js)
            skyDrop.start(x, y, -100 - (S.meteorN = (S.meteorN + 1) % 40), 95, extra | 0, true, 'meteor');
            return true;
        case "tankdead": {
            // someone else went down near you: their colour shatters out (the
            // app's own burst still plays)
            const id = extra | 0;
            let col = "#c8c8c8";
            const list = global.entities;
            for (let i = 0; i < list.length; i++) if (list[i].id === id) { col = colorHex(list[i].color) || col; break; }
            juice.sparks(x, y, 34, 380, 950, 1, col, TAU, 0, 13);
            juice.sparks(x, y, 18, 300, 800, 1, "#2b2433", TAU, 0, 10);
            juice.sparks(x, y, 24, 320, 1100, 3, GOLD, TAU, 0, 6);
            juice.sparks(x, y, 12, 260, 1000, 3, "#6ff5a8", TAU, 0, 6);
            ring(x, y, "#ffffff", 20, 380, 460, 18);
            ring(x, y, col, 20, 280, 700, 12);
            return false;
        }
        case "rattler":
            ring(x, y, ORANGE, 20, 260, 600, 8);
            juice.sparks(x, y, 18, 220, 700, 1, "#2b2433", TAU, 0, 7);
            juice.sparks(x, y, 12, 260, 600, 0, ORANGE);
            try { if (gameSound.rockBreak) gameSound.rockBreak(x, y); } catch (e) { /* */ }
            return true;
        case "rattlergone":
            juice.sparks(x, y, 12, 140, 600, 1, "#2b2433", TAU, 0, 6);
            return true;
    }
    return false;
}

// DEAD: you killed someone at (x, y)
export function onKill(x, y) {
    ring(x, y, "#ffffff", 20, 460, 420, 20);
    ring(x, y, GOLD, 20, 300, 700, 12);
    juice.sparks(x, y, 30, 340, 1100, 3, GOLD, TAU, 0, 7);
    juice.sparks(x, y, 18, 280, 1000, 3, "#6ff5a8", TAU, 0, 6);
    juice.sparks(x, y, 14, 240, 900, 2, "#9ff6ff", TAU, 0, 7);
    juice.slowMo(380, 0.3);
    juice.shake(40, 420);
    juice.flash("#ffffff", 120, 0.22);
}
// DMG: sparks where it landed; a hard hit on you tears the screen
export function onHit(targetId, amount, tier, taken) {
    if (taken) {
        const me = S.me;
        // the screen cracks on the side the hit came from (the nearest enemy)
        if (amount >= 8) {
            S.hitAt = performance.now();
            S.hitAng = isFinite(S.foeAng) ? S.foeAng : Math.random() * TAU;
            S.hitSet = (S.hitSet + 1) % hitCracks.length;
        }
        if (me) juice.sparks(me.x, me.y, 4 + Math.min(10, amount >> 2), 160, 380, 0, "#ff6b5e");
        if (amount >= 18 || (S.mine && amount >= 6)) {
            // Effects: Normal glitches only on a hard hit at low health
            juice.glitch(S.mine ? 0.75 : 0.45, 200, S.lowHp > 0.5 && amount >= 18);
            juice.flash("#ff2030", 90, S.mine ? 0.18 : 0.1);
        }
        return;
    }
    const list = global.entities;
    for (let i = 0; i < list.length; i++) {
        const e = list[i];
        if (e.id !== targetId) continue;
        juice.sparks(e.x, e.y, 3 + Math.min(12, amount >> 2), 120 + 4 * amount, 320, 0, tier >= 2 ? "#ffd76e" : "#ffffff");
        if (tier >= 2) ring(e.x, e.y, "#ffd76e", 10, 90, 260, 6);
        break;
    }
}
// GEM: a glint as each pickup lands
export function onGem(delta) {
    const me = S.me;
    if (!me || !(delta > 0)) return;
    juice.sparks(me.x, me.y, delta >= 50 ? 5 : 2, 70, 380, 3, delta >= 100 ? "#6ff5a8" : GOLD, TAU, 0, 4);
}
function colorHex(c) {
    try { const h = A && A.colorOf ? A.colorOf(c) : null; return typeof h === "string" && h[0] === "#" ? h : null; } catch (e) { return null; }
}

// the few new sounds, made from the existing ones
function sfx(kind) {
    try {
        if (kind === "alarm") { if (gameSound.stormWarn) gameSound.stormWarn(); }
        else if (kind === "relief") { if (gameSound.bankCelebrate) gameSound.bankCelebrate(); }
        else if (kind === "core") { if (gameSound.rankShatter) gameSound.rankShatter(); }
        else if (kind === "win") { if (gameSound.rankUp) gameSound.rankUp(true); }
        else if (kind === "impact") { if (gameSound.oreBreak) gameSound.oreBreak(global.player.renderx, global.player.rendery, 3); }
    } catch (e) { /* */ }
}
function fmt(n) { return A && A.fmtNum ? A.fmtNum(n) : String(n); }
function fmtK(n) { return n >= 1000 ? (Math.floor(n / 100) / 10).toFixed(1).replace(/\.0$/, "") + "k" : String(n | 0); }
// hunt rows are new objects every RY: the short number is worked out once each
function numOf(h) { return h._k || (h._k = fmtK(h.g | 0)); }

// ── per frame ──────────────────────────────────────────────────────────
function mateId() {
    const r = global.royale;
    const m = r && r.duos && r.duo && r.duo.mate;
    return m ? m.id : -1;
}
function threatScan(now) {
    if (now - S.threatAt < 100) return;
    S.threatAt = now;
    const myId = gui.playerid, mid = mateId();
    let me = null;
    const list = global.entities;
    for (let i = 0; i < list.length; i++) if (list[i].id === myId) { me = list[i]; break; }
    S.me = me;
    S.lowHp = me && !global.died && me.health < 0.3 ? clamp((0.3 - me.health) / 0.25) : 0;
    let t = 0, lock = false;
    // where the nearest enemy is, for the hit cracks
    let nd = 1400;
    S.foeAng = NaN;
    if (me && !global.died) {
        for (let i = 0; i < list.length; i++) {
            const e = list[i];
            if (!e.nameplate || e.id === myId || e.id === mid || !(e.alpha > 0.1)) continue;
            const d = Math.hypot(e.x - me.x, e.y - me.y);
            if (d < nd) { nd = d; S.foeAng = Math.atan2(e.y - me.y, e.x - me.x); }
        }
    }
    if (me && S.mine && !global.died) {
        for (let i = 0; i < list.length; i++) {
            const e = list[i];
            if (!e.nameplate || e.id === myId || e.id === mid || !(e.alpha > 0.1)) continue;
            const dx = me.x - e.x, dy = me.y - e.y;
            const d = Math.hypot(dx, dy);
            if (d > 950) continue;
            let err = Math.atan2(dy, dx) - (e.facing || 0);
            err = Math.atan2(Math.sin(err), Math.cos(err));
            t = Math.max(t, JM.threatOf(d, err, 950));
            if (d < 900 && Math.abs(err) < 0.3) lock = true;
        }
    }
    if (lock && !S.lockAim) S.lockFrom = now;
    S.lockAim = lock;
    // ease up fast, settle slowly
    S.threat += (t - S.threat) * (t > S.threat ? 0.6 : 0.15);
}

// app.js, before the HUD: the heartbeat load for sound.satchelTension
export function tension() {
    if (global.died || !global.gameStart) return 0;
    const h = JM.huntTension(S.mine, S.threat);
    const lo = S.lowHp > 0 ? 0.42 + 0.5 * S.lowHp : 0;
    return Math.max(h, lo);
}

function frame(now) {
    threatScan(now);
    const r = global.royale;
    // glitch levels for juice.postWorld
    if (!global.died) {
        if (S.mine) juice.ambient(0.18 + 0.12 * S.mine + 0.35 * S.threat);
        if (S.lowHp) juice.ambient(0.3 + 0.6 * S.lowHp);
        const c = S.core;
        if (c && c.s === "up" && near(c.x, c.y, 1100)) juice.ambient(c.hp < 0.5 ? 0.4 : 0.15);
        const st = r && r.storm;
        if (st && st.a && st.r > 0) {
            const d = Math.hypot(global.player.renderx - (st.cx || 0), global.player.rendery - (st.cy || 0));
            const edge = d - st.r;
            if (edge > 0) {
                juice.staticNoise(0.85); juice.ambient(0.3);
                // lightning now and then while you're out in it
                if (now > S.lightningAt) {
                    if (S.lightningAt) { juice.flash("#d8e2ff", 140, 0.22); juice.shake(8, 160); }
                    S.lightningAt = now + 2500 + Math.random() * 5000;
                }
            } else if (S.lightningAt) S.lightningAt = 0;
            else if (edge > -260) juice.staticNoise(0.5 * (1 + edge / 260));
        }
    }
    // the calm HUD for a first raid: until the first bank
    let calmHud = false;
    try { calmHud = !!(A && A.coachOn && A.coachOn()) && !((r && r.you && r.you.banked) > 0); } catch (e) { calmHud = false; }
    global.hudCalm = calmHud;
    bankWatch(now);
}

// every bank: a slam; the first one this raid is the big one
function bankWatch(now) {
    const v = global.vault, g = global.gems;
    if (!v || !g) return;
    if (v.total > 0 && S.depStart < 0) S.depStart = g.banked | 0;
    // depositing: gems stream down into the vault, a pulse on the pad
    if (v.total > 0 && v.remaining > 0 && !global.died) {
        const x = global.player.renderx, y = global.player.rendery;
        if (now - S.depTickAt > 110) {
            S.depTickAt = now;
            const a = Math.random() * TAU;
            juice.sparks(x + Math.cos(a) * 170, y + Math.sin(a) * 170, 2, -150, 420, 3, Math.random() < 0.5 ? GOLD : "#7fb1f2", 0.6, a, 5);
        }
        if (now - S.depRingAt > 650) { S.depRingAt = now; ring(x, y, GOLD, 60, 190, 600, 6); }
    }
    if (v.doneAt && v.doneAt !== S.doneAt) {
        const first = !S.doneAt;
        S.doneAt = v.doneAt;
        if (first && now - v.doneAt > 1500) { S.depStart = -1; return; }
        const got = S.depStart >= 0 ? Math.max(0, (g.banked | 0) - S.depStart) : 0;
        S.depStart = -1;
        if (got <= 0) return;
        const x = global.player.renderx, y = global.player.rendery;
        if (got >= 500) {
            juice.sparks(x, y, 46, 260, 1600, 4, null, TAU, 0, 7);
            juice.lightLeak("242,184,60", 1400);
        }
        if (!S.firstBank) {
            S.firstBank = true;
            juice.slamRoll("BANKED +", 0, got, "Dying can't take these now.", GOLD, 2400, 62, fmt);
            juice.shake(24, 360);
            sfx("relief");
            juice.sparks(x, y, 26, 260, 900, 3, GOLD, TAU, 0, 6);
            ring(x, y, GOLD, 30, 320, 700, 10);
        } else if (got >= 100) {
            juice.slamRoll("+", 0, got, "banked", GOLD, 1300, got >= 500 ? 40 : 32, fmt);
            ring(x, y, GOLD, 30, 260, 600, 8);
        }
    }
}

// ── world: under the tanks (background layer) ───────────────────────────
export function drawFloor(c, px, py, ratio) {
    juice.frameStart(performance.now());
    skyDrop.drawGround(c, px, py, ratio);
    drawCoreGround(c, px, py, ratio);
    drawSupplyGround(c, px, py, ratio);
    const core = S.core;
    if (!core || core.s !== "up") return;
    const sx = ratio * core.x - px + global.screenWidth / 2, sy = ratio * core.y - py + global.screenHeight / 2;
    const R = PULSE_R * ratio;
    if (sx < -R || sy < -R || sx > global.screenWidth + R || sy > global.screenHeight + R) return;
    const now = performance.now();
    const left = Math.max(0, (core.p || 0) - (now - (global.royale.at || now)));
    // the charge: brighter the closer the next shockwave is
    const charge = left < 900 ? 1 - left / 900 : 0;
    c.save();
    if (juice.glowOn() && A && A.haloSprite) {
        const hot = core.hp < 0.5;
        const hr = (core.r * 3.2 + 60 * charge) * ratio;
        c.globalAlpha = 0.35 + 0.35 * charge + (calm() ? 0 : 0.06 * Math.sin(now / 300));
        c.drawImage(A.haloSprite(hot ? "coreHot" : "core", hot ? "255,90,216" : CORE_RGB, [[0, 0.9], [0.45, 0.35], [1, 0]]), sx - hr, sy - hr, hr * 2, hr * 2);
    }
    // where the shockwave reaches
    c.globalAlpha = 0.18 + 0.4 * charge;
    c.strokeStyle = core.hp < 0.5 ? CORE_HOT : CORE;
    c.lineWidth = Math.max(1.5, 3 * ratio);
    DASH[0] = 18 * ratio; DASH[1] = 14 * ratio;
    c.setLineDash(DASH);
    c.lineDashOffset = calm() ? 0 : -now / 60;
    c.beginPath(); c.arc(sx, sy, R, 0, TAU); c.stroke();
    c.setLineDash(NO_DASH);
    c.restore();
}
const DASH = [18, 14], NO_DASH = [];
// a supply drop on its way: its exact footprint marked on the ground until
// the falling crate's own marker takes over (skyDrop.js)
function drawSupplyGround(c, px, py, ratio) {
    const sup = global.royale && global.royale.supply;
    if (!sup || sup.s !== "soon") return;
    const now = performance.now();
    const left = (sup.left || 0) - (now - (global.royale.at || now));
    if (left < 1500) return;
    const R = (sup.z || S.supplyZ || 72) * ratio;
    const sx = ratio * sup.x - px + global.screenWidth / 2, sy = ratio * sup.y - py + global.screenHeight / 2;
    if (sx < -R * 2 || sy < -R * 2 || sx > global.screenWidth + R * 2 || sy > global.screenHeight + R * 2) return;
    const beat = calm() ? 0.5 : 0.5 + 0.5 * Math.sin(now / 260);
    c.save();
    c.globalAlpha = 0.1 + 0.08 * beat;
    c.fillStyle = "#6ff5a8";
    c.beginPath(); c.arc(sx, sy, R, 0, TAU); c.fill();
    c.globalAlpha = 0.55 + 0.3 * beat;
    c.strokeStyle = "#6ff5a8"; c.lineWidth = Math.max(1.5, 3 * ratio);
    DASH[0] = 14 * ratio; DASH[1] = 10 * ratio;
    c.setLineDash(DASH);
    c.lineDashOffset = calm() ? 0 : -now / 50;
    c.beginPath(); c.arc(sx, sy, R, 0, TAU); c.stroke();
    c.setLineDash(NO_DASH);
    c.restore();
}
// the Core surfacing cracks the ground open: lines racing out, then fading
function drawCoreGround(c, px, py, ratio) {
    const age = performance.now() - S.beamsAt;
    if (age < 0 || age > 9000) return;
    const sx = ratio * S.coreX - px + global.screenWidth / 2, sy = ratio * S.coreY - py + global.screenHeight / 2;
    const reach = 760 * ratio * Math.min(1, age / 2200);
    const a = age < 6500 ? 1 : 1 - (age - 6500) / 2500;
    c.save();
    c.lineCap = "round";
    for (let pass = 0; pass < 2; pass++) {
        c.globalAlpha = (pass ? 0.75 : 0.5) * a;
        c.strokeStyle = pass ? CORE : "#0c0a0e";
        c.lineWidth = Math.max(1, (pass ? 2 : 6) * ratio);
        for (const p of groundCracks) {
            c.beginPath();
            c.moveTo(sx + p[0] * reach, sy + p[1] * reach);
            for (let i = 2; i < p.length; i += 2) c.lineTo(sx + p[i] * reach, sy + p[i + 1] * reach);
            c.stroke();
        }
    }
    c.restore();
}

// ── the Core itself (entity pass, gameplay layer) ──────────────────────
export function isCoreEntity(e) {
    if (!e || !e.index) return false;
    if (e._isCore !== undefined) return e._isCore;
    let yes = false;
    try {
        const m = global.mockups[parseInt(String(e.index).split("-")[0], 10)];
        yes = !!m && (m.className === "royaleCore" || m.name === "The Core");
    } catch (err) { yes = false; }
    e._isCore = yes;
    return yes;
}
// A geode fracture, in units of the Core's radius, fixed per Core: six main
// cracks from the heart out to the shell between the spikes, each forking
// once, and a ring crack joining them. Stage 1 (25% down) the inner halves,
// 2 (50%) to the shell with the forks, 3 (75%) the ring.
function crackSet(id) {
    if (S.coreCrackId === id && S.coreCracks) return S.coreCracks;
    S.coreCrackId = id;
    const rays = [], forks = [], ring = [];
    for (let i = 0; i < 6; i++) {
        const a0 = i * TAU / 6 + (JM.hash01(id, i) - 0.5) * 0.25;
        const pts = [];
        for (let k = 0; k <= 4; k++) {
            const r = 0.18 + 0.21 * k, a = a0 + (JM.hash01(id + k, i * 3) - 0.5) * 0.18;
            pts.push(Math.cos(a) * r, Math.sin(a) * r);
        }
        rays.push(pts);
        // a fork from about halfway out, leaning to one side
        const side = JM.hash01(id, i * 11) < 0.5 ? -1 : 1, af = a0 + side * (0.32 + 0.12 * JM.hash01(id, i * 13));
        forks.push([pts[4], pts[5], Math.cos(af) * 0.78, Math.sin(af) * 0.78, Math.cos(af + side * 0.1) * 0.98, Math.sin(af + side * 0.1) * 0.98]);
        ring.push(Math.cos(a0) * 0.6, Math.sin(a0) * 0.6);
    }
    S.coreCracks = { rays, forks, ring };
    return S.coreCracks;
}
function crackPath(c, x, y, R, pts, upto, ca, sa) {
    for (let k = 0; k + 1 < pts.length && k / 2 <= upto; k += 2) {
        const ux = pts[k] * ca - pts[k + 1] * sa, uy = pts[k] * sa + pts[k + 1] * ca;
        if (k) c.lineTo(x + ux * R, y + uy * R); else c.moveTo(x + ux * R, y + uy * R);
    }
}
function hexPath(c, x, y, r, rot) {
    c.beginPath();
    for (let i = 0; i < 6; i++) {
        const a = rot + i * TAU / 6;
        if (i) c.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r); else c.moveTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
    }
    c.closePath();
}
// c: gameplay layer; x, y screen position; isize the entity size
export function drawCore(c, x, y, e, ratio, alpha, isize) {
    const now = performance.now();
    const R = (isize || e.size || 100) * ratio;
    const hp = clamp(e.health != null ? e.health : 1);
    if (hp < S.coreLastHp - 0.0005) S.coreHitAt = now;
    S.coreLastHp = hp;
    const hot = hp < 0.5;
    const f = (e.render && e.render.f) || 0;
    const beat = calm() ? 0 : Math.sin(now / (hot ? 140 : 320));
    c.save();
    c.globalAlpha = alpha;
    c.lineJoin = "round";
    // crystal spikes round the shell, breathing
    for (let i = 0; i < 6; i++) {
        const a = f * 0.6 + i * TAU / 6 + Math.PI / 6;
        const len = R * (1.45 + 0.08 * Math.sin(now / 380 + i * 1.7) * (calm() ? 0 : 1));
        const w = R * 0.32, ca = Math.cos(a), sa = Math.sin(a), nx = -sa, ny = ca;
        const bx = x + ca * R * 0.5, by = y + sa * R * 0.5;
        const tx = x + ca * len, ty = y + sa * len;
        const mx = x + ca * R * 0.95, my = y + sa * R * 0.95;
        c.beginPath(); c.moveTo(bx, by); c.lineTo(mx + nx * w, my + ny * w); c.lineTo(tx, ty); c.closePath();
        c.fillStyle = hot ? "#ff8ae3" : "#9ff6ff"; c.fill();
        c.beginPath(); c.moveTo(bx, by); c.lineTo(mx - nx * w, my - ny * w); c.lineTo(tx, ty); c.closePath();
        c.fillStyle = hot ? "#c93aa8" : "#2fb8d8"; c.fill();
        c.beginPath(); c.moveTo(bx, by); c.lineTo(mx + nx * w, my + ny * w); c.lineTo(tx, ty); c.lineTo(mx - nx * w, my - ny * w); c.closePath();
        c.strokeStyle = "#0c0a0e"; c.lineWidth = Math.max(2, 3.2 * ratio); c.stroke();
    }
    // the dark shell
    hexPath(c, x, y, R * 1.02, f);
    c.fillStyle = "#1d1630"; c.fill();
    c.strokeStyle = "#0c0a0e"; c.lineWidth = Math.max(2.5, 4.5 * ratio); c.stroke();
    hexPath(c, x, y, R * 0.86, f);
    c.strokeStyle = hot ? "rgba(255,90,216,0.55)" : "rgba(92,232,255,0.5)"; c.lineWidth = Math.max(1.5, 2.5 * ratio); c.stroke();
    // the heart
    const hr = R * (0.5 + 0.04 * beat);
    if (juice.glowOn() && A && A.haloSprite) {
        const gr = hr * 2.4;
        c.globalAlpha = alpha * (0.75 + 0.2 * beat);
        c.drawImage(A.haloSprite(hot ? "coreHeartHot" : "coreHeart", hot ? "255,120,220" : "255,244,194", [[0, 1], [0.35, 0.6], [1, 0]]), x - gr, y - gr, gr * 2, gr * 2);
        c.globalAlpha = alpha;
    }
    hexPath(c, x, y, hr, -f * 1.4);
    c.fillStyle = hot ? "#ffc2f0" : "#fff4c2"; c.fill();
    c.strokeStyle = "#0c0a0e"; c.lineWidth = Math.max(2, 3 * ratio); c.stroke();
    hexPath(c, x, y, hr * 0.5, f * 2);
    c.fillStyle = "#ffffff"; c.fill();
    // the fracture grows in steps (25 / 50 / 75% down), kept inside the
    // shell and lit from inside: a wide glow, a dark edge, a bright core line
    const stage = hp > 0.75 ? 0 : hp > 0.5 ? 1 : hp > 0.25 ? 2 : 3;
    if (stage > 0) {
        const cr = crackSet(e.id | 0);
        const ca = Math.cos(f), sa = Math.sin(f);
        const upto = stage === 1 ? 2 : 4;
        c.save();
        hexPath(c, x, y, R * 0.98, f);
        c.clip();
        c.lineCap = "round"; c.lineJoin = "round";
        const glow = hot ? "rgba(255,90,216," : "rgba(92,232,255,";
        const passes = [[glow + (0.35 + 0.15 * Math.max(0, beat)) + ")", 9], ["#0c0a0e", 3.6], [hot ? "#ffd6f6" : "#e8fdff", 1.5]];
        for (const [col, w] of passes) {
            c.strokeStyle = col;
            c.lineWidth = Math.max(1, w * ratio * (stage === 3 && w > 5 ? 1.3 : 1));
            c.beginPath();
            for (const p of cr.rays) crackPath(c, x, y, R, p, upto, ca, sa);
            if (stage >= 2) for (const p of cr.forks) crackPath(c, x, y, R, p, 2, ca, sa);
            if (stage >= 3) {
                const q = cr.ring;
                for (let i = 0; i <= 6; i++) {
                    const j = (i % 6) * 2, ux = q[j] * ca - q[j + 1] * sa, uy = q[j] * sa + q[j + 1] * ca;
                    if (i) c.lineTo(x + ux * R, y + uy * R); else c.moveTo(x + ux * R, y + uy * R);
                }
            }
            c.stroke();
        }
        c.restore();
    }
    // winding up an attack: the heart flares and a ring closes on the Core
    const ca2 = now - S.chargeAt;
    if (ca2 >= 0 && ca2 < S.chargeMs) {
        const k = ca2 / S.chargeMs;
        const col = S.chargePulse ? "#ffffff" : (hot ? "#ff8ae3" : "#9ff6ff");
        if (juice.glowOn() && A && A.haloSprite) {
            const gr = R * (1.2 + 1.3 * k);
            c.globalAlpha = alpha * (0.35 + 0.55 * k);
            c.drawImage(A.haloSprite(hot ? "coreHeartHot" : "coreHeart", hot ? "255,120,220" : "255,244,194", [[0, 1], [0.35, 0.6], [1, 0]]), x - gr, y - gr, gr * 2, gr * 2);
        }
        c.globalAlpha = alpha * (0.4 + 0.6 * k);
        c.strokeStyle = col; c.lineWidth = Math.max(2, (S.chargePulse ? 7 : 4) * ratio);
        c.beginPath(); c.arc(x, y, R * (1.15 + (S.chargePulse ? 2.6 : 1.4) * (1 - k)), 0, TAU); c.stroke();
        c.globalAlpha = alpha;
    }
    // a hit flash
    const ha = now - S.coreHitAt;
    if (ha < 90) {
        c.globalAlpha = alpha * 0.35 * (1 - ha / 90);
        hexPath(c, x, y, R * 1.02, f);
        c.fillStyle = "#ffffff"; c.fill();
    }
    c.restore();
}

// ── world: over the tanks (top layer, world coordinates) ──────────────
let vPx = 0, vPy = 0, vR = 1, vCx = 0, vCy = 0;
const toX = (wx) => vR * wx - vPx + vCx, toY = (wy) => vR * wy - vPy + vCy;
export function drawWorld(c, px, py, ratio) {
    const now = performance.now();
    frame(now);
    vPx = px; vPy = py; vR = ratio; vCx = global.screenWidth / 2; vCy = global.screenHeight / 2;
    c.save();
    c.lineCap = "round";
    // shockwaves from the Core
    for (const p of pulses) {
        const age = now - p.born;
        if (age < 0 || age > 700) continue;
        const k = age / 700, e = 1 - (1 - k) * (1 - k) * (1 - k);
        const R = (90 + (PULSE_R - 90) * e) * ratio;
        c.globalAlpha = (1 - k) * 0.85;
        c.strokeStyle = "#ffffff"; c.lineWidth = Math.max(2, 16 * (1 - k) * ratio);
        c.beginPath(); c.arc(toX(p.x), toY(p.y), R, 0, TAU); c.stroke();
        c.globalAlpha = (1 - k) * 0.6;
        c.strokeStyle = CORE; c.lineWidth = Math.max(1.5, 7 * (1 - k) * ratio);
        c.beginPath(); c.arc(toX(p.x), toY(p.y), R * 0.88, 0, TAU); c.stroke();
    }
    // crystal shards in flight, with a warning where they land
    for (const s of shards) {
        const age = now - s.born;
        const SMS = s.ms || SHARD_MS;
        if (age < 0 || age > SMS + 260) continue;
        const tx = toX(s.x), ty = toY(s.y);
        if (age < SMS) {
            const k = age / SMS;
            c.globalAlpha = 0.5 + 0.4 * k;
            c.strokeStyle = RED; c.lineWidth = Math.max(1.5, 3 * ratio);
            c.beginPath(); c.arc(tx, ty, (70 - 30 * k) * ratio, 0, TAU); c.stroke();
            const sx = toX(s.fx + (s.x - s.fx) * k * k), sy = toY(s.fy + (s.y - s.fy) * k * k);
            const a = Math.atan2(s.y - s.fy, s.x - s.fx);
            const L = 52 * ratio, W = 15 * ratio, ca = Math.cos(a), sa = Math.sin(a);
            c.globalAlpha = 1;
            c.beginPath();
            c.moveTo(sx + ca * L, sy + sa * L); c.lineTo(sx - sa * W, sy + ca * W);
            c.lineTo(sx - ca * L * 0.6, sy - sa * L * 0.6); c.lineTo(sx + sa * W, sy - ca * W); c.closePath();
            c.fillStyle = S.core && S.core.hp < 0.5 ? "#ff8ae3" : "#9ff6ff"; c.fill();
            c.strokeStyle = "#0c0a0e"; c.lineWidth = Math.max(1.5, 2.5 * ratio); c.stroke();
        } else {
            const k = (age - SMS) / 260;
            if (!s.hit) {
                s.hit = true;
                juice.sparks(s.x, s.y, 10, 140, 420, 2, "#9ff6ff", TAU, 0, 5);
                if (near(s.x, s.y, 300)) juice.shake(16, 200);
            }
            c.globalAlpha = 1 - k;
            c.strokeStyle = "#ffffff"; c.lineWidth = Math.max(1.5, 6 * (1 - k) * ratio);
            c.beginPath(); c.arc(tx, ty, (30 + 60 * k) * ratio, 0, TAU); c.stroke();
        }
    }
    // the Core going down: a white-out close by
    if (S.downAt) {
        const age = now - S.downAt;
        if (age < 260 && near(S.downX, S.downY, 1500)) {
            c.globalAlpha = (1 - age / 260) * 0.55;
            c.fillStyle = "#ffffff";
            c.fillRect(0, 0, global.screenWidth, global.screenHeight);
        }
    }
    // light beams out of the Core as it surfaces
    const ba = now - S.beamsAt;
    if (ba >= 0 && ba < 3800 && juice.glowOn()) {
        const bx = toX(S.coreX), by = toY(S.coreY);
        const fade = ba < 400 ? ba / 400 : 1 - (ba - 400) / 3400;
        const L = Math.hypot(global.screenWidth, global.screenHeight) * 0.8;
        c.save();
        c.globalCompositeOperation = "lighter";
        c.fillStyle = "#9ff6ff";
        for (let i = 0; i < 8; i++) {
            const a = i * TAU / 8 + ba / 2600, w = 0.07 + 0.04 * Math.sin(ba / 300 + i);
            c.globalAlpha = 0.16 * fade;
            c.beginPath(); c.moveTo(bx, by);
            c.lineTo(bx + Math.cos(a - w) * L, by + Math.sin(a - w) * L);
            c.lineTo(bx + Math.cos(a + w) * L, by + Math.sin(a + w) * L);
            c.closePath(); c.fill();
        }
        c.restore();
    }
    // locked on: an enemy close by has its gun on you while you're hunted
    if (S.lockAim && S.mine && !global.died) drawLock(c, vCx, vCy, ratio, now);
    skyDrop.drawAir(c, px, py, ratio);
    juice.drawSparks(c, px, py, ratio);
}
function drawLock(c, x, y, ratio, now) {
    const t = Math.min(1, (now - S.lockFrom) / 220);
    const R = (70 + 50 * (1 - t)) * ratio;
    const spin = calm() ? 0 : now / 700;
    c.save();
    c.lineCap = "round";
    c.globalAlpha = 0.55 + 0.35 * Math.sin(now / 90);
    for (let pass = 0; pass < 2; pass++) {
        c.strokeStyle = pass ? RED : "#120e15";
        c.lineWidth = Math.max(pass ? 2 : 4, (pass ? 3 : 6) * ratio);
        for (let i = 0; i < 4; i++) {
            const a = spin + i * Math.PI / 2;
            c.beginPath(); c.arc(x, y, R, a - 0.35, a + 0.35); c.stroke();
        }
    }
    c.restore();
    if (A) A.drawText("LOCKED", x, y + R + 14, 12, RED, "center", true, 0.9, 5);
}

// after the world, before the HUD (app.js renderFrame)
export function postWorld(ctxs) {
    // low health drains the colour out of the world
    if (S.lowHp > 0.05 && !global.died && juice.glowOn() && !lite()) {
        const c0 = ctxs[0];
        c0.save();
        c0.setTransform(1, 0, 0, 1, 0, 0);
        c0.globalCompositeOperation = "saturation";
        c0.globalAlpha = 0.55 * S.lowHp;
        c0.fillStyle = "#808080";
        c0.fillRect(0, 0, c0.canvas.width, c0.canvas.height);
        c0.restore();
    }
    juice.postWorld(ctxs);
}

// ── edge markers (app.js drawRoyaleWorldMarkers) ────────────────────────
export function worldMarks(marks, toScreen, onScreen, me, trackPos, ratio) {
    const r = global.royale;
    const scr = global.screenWidth / Math.max(0.05, ratio);
    const myId = gui.playerid, mid = mateId();
    let best = null;
    if (r.hunt) for (const h of r.hunt) {
        if (h.e === myId || h.e === mid) continue;
        const p = trackPos("hunt" + h.e, h.x, h.y, 0.7);
        const s = toScreen(p.x, p.y);
        if (onScreen(s, -20)) continue;
        const d = Math.hypot(p.x - me.x, p.y - me.y);
        if (d > scr * (h.l >= 2 ? 2.5 : 1.5)) continue;
        if (!best || h.l > best.l || (h.l === best.l && d < best.d)) best = { pri: 1.5, s, col: RED, glyph: "skull", name: (h.l >= 2 ? "TOP TARGET " : "HUNTED ") + numOf(h), d, l: h.l };
    }
    if (best) marks.push(best);
    const sp = r.supply;
    if (sp) {
        const s = toScreen(sp.x, sp.y);
        if (!onScreen(s, -40)) marks.push({ pri: 0.8, s, col: "#6ff5a8", glyph: "gem", name: sp.s === "soon" ? "SUPPLY DROP " + Math.ceil((sp.left || 0) / 1000) + "s" : "SUPPLY CRATE", d: Math.hypot(sp.x - me.x, sp.y - me.y) });
    }
    const c = r.core;
    if (c && c.s === "up") {
        const s = toScreen(c.x, c.y);
        if (!onScreen(s, -60)) marks.push({ pri: 0.5, s, col: CORE, glyph: "gem", name: "THE CORE", d: Math.hypot(c.x - me.x, c.y - me.y) });
    }
}

// ── overhead badge (app.js badgeOf) ─────────────────────────────────────
const badges = new Map();
export function badge(id) {
    const h = S.huntById.get(id);
    if (!h || id === mateId()) return null;
    const word = h.l >= 2 ? "TOP TARGET " : "HUNTED ";
    const num = numOf(h);
    const key = "hu" + h.l + num;
    let b = badges.get(key);
    if (!b) {
        if (badges.size > 60) badges.clear();
        b = { key, word, num, col: RED };
        badges.set(key, b);
    }
    return b;
}

// ── minimap / big map (app.js drawRoyaleMapExtras) ─────────────────────
export function drawMap(c, T, inside, dotR, pulse, mapLabel, trackPos) {
    const r = global.royale;
    const myId = gui.playerid, mid = mateId();
    const now = performance.now();
    const core = r.core;
    if (core) {
        const mx = T.X(core.x), my = T.Y(core.y);
        if (inside(mx, my)) {
            const col = core.s === "down" ? GOLD : core.hp < 0.5 ? CORE_HOT : CORE;
            c.save();
            if (core.s === "soon") {
                c.globalAlpha = 0.5 + 0.4 * Math.sin(now / 200);
                c.strokeStyle = CORE; c.lineWidth = 1.6;
                c.beginPath(); c.arc(mx, my, dotR * 2.4 * pulse, 0, TAU); c.stroke();
            } else {
                hexPath(c, mx, my, dotR * (core.s === "up" ? 2.2 : 1.6), now / 900);
                c.fillStyle = col; c.strokeStyle = "#000"; c.lineWidth = 1.6; c.fill(); c.stroke();
                if (core.s === "up") {
                    c.globalAlpha = 0.85;
                    c.strokeStyle = col; c.lineWidth = 2;
                    c.beginPath(); c.arc(mx, my, dotR * 4 * pulse, 0, TAU); c.stroke();
                }
            }
            // the ping when it surfaces: three rings rolling out on the map
            const pa = now - S.coreUpAt;
            if (core.s === "up" && pa < 6000) {
                c.save();
                c.strokeStyle = CORE; c.lineWidth = 2;
                for (let i = 0; i < 3; i++) {
                    const k = ((pa / 1400) + i / 3) % 1;
                    c.globalAlpha = (1 - k) * (1 - pa / 6000);
                    c.beginPath(); c.arc(mx, my, dotR * (3 + 14 * k), 0, TAU); c.stroke();
                }
                c.restore();
            }
            c.restore();
            if (core.s !== "soon") mapLabel(core.s === "down" ? "CORE (BROKEN)" : "THE CORE", mx, my + dotR * 4, false, col);
        }
    }
    const sup = r.supply;
    if (sup) {
        const mx = T.X(sup.x), my = T.Y(sup.y);
        if (inside(mx, my)) {
            const s2 = dotR * 2.8 * (sup.s === "soon" ? 0.9 + 0.15 * Math.sin(now / 160) : 1);
            c.save();
            const pa = now - S.supplyPingAt;
            if (pa < 6000) {
                c.strokeStyle = GOLD; c.lineWidth = 2;
                for (let i = 0; i < 3; i++) {
                    const k = ((pa / 1400) + i / 3) % 1;
                    c.globalAlpha = (1 - k) * (1 - pa / 6000);
                    c.beginPath(); c.arc(mx, my, dotR * (3 + 14 * k), 0, TAU); c.stroke();
                }
            }
            c.globalAlpha = 1;
            c.fillStyle = "#2eaa68"; c.strokeStyle = "#000"; c.lineWidth = 2;
            c.fillRect(mx - s2, my - s2, s2 * 2, s2 * 2); c.strokeRect(mx - s2, my - s2, s2 * 2, s2 * 2);
            c.fillStyle = "#6ff5a8";
            c.fillRect(mx - s2, my - s2 * 0.2, s2 * 2, s2 * 0.4); c.fillRect(mx - s2 * 0.2, my - s2, s2 * 0.4, s2 * 2);
            c.restore();
            const lt = sup.s === "soon" ? Math.ceil(Math.max(0, (sup.left || 0) - (performance.now() - (r.at || 0))) / 1000) + "s" : "CRATE";
            A.drawText(lt, mx, my - s2 - 9, Math.max(10, dotR * 4.2), "#6ff5a8", "center", true, 1, 5);
        }
    }
    const ba = now - S.bossUpAt;
    if (r.boss && ba < 6000) {
        const mx = T.X(S.bossX), my = T.Y(S.bossY);
        if (inside(mx, my)) {
            c.save();
            c.strokeStyle = r.boss.c || "#c9a8ff"; c.lineWidth = 2;
            for (let i = 0; i < 3; i++) {
                const k = ((ba / 1400) + i / 3) % 1;
                c.globalAlpha = (1 - k) * (1 - ba / 6000);
                c.beginPath(); c.arc(mx, my, dotR * (3 + 14 * k), 0, TAU); c.stroke();
            }
            c.restore();
        }
    }
    if (!r.hunt) return;
    for (const h of r.hunt) {
        if (h.e === myId || h.e === mid) continue;
        const tp = trackPos("hunt" + h.e, h.x, h.y, 0.7);
        const mx = T.X(tp.x), my = T.Y(tp.y);
        if (!inside(mx, my)) continue;
        const top = h.l >= 2;
        const beat = 0.5 + 0.5 * Math.sin(now / (top ? 140 : 220));
        c.save();
        c.globalAlpha = 0.55 + 0.45 * beat;
        c.strokeStyle = RED; c.lineWidth = top ? 2.6 : 1.8;
        c.beginPath(); c.arc(mx, my, dotR * (top ? 4.4 : 3) * (0.85 + 0.3 * beat), 0, TAU); c.stroke();
        c.globalAlpha = 1;
        c.fillStyle = RED; c.strokeStyle = "#000"; c.lineWidth = 1.6;
        c.beginPath(); c.arc(mx, my, dotR * (top ? 1.7 : 1.25), 0, TAU); c.fill(); c.stroke();
        c.restore();
        if (top) mapLabel(numOf(h), mx, my - dotR * 4.6, true, RED);
    }
}

// ── the Core's card under the clock (app.js lays out the row: beside the
// boss card when both are up) ──────────────────────────────────────────
export function coreUp() {
    const core = global.royale && global.royale.core;
    return !!(core && core.s === "up" && !global.died);
}
// the card at x, y, w x h (h ~44): name and prize, the bar, % and range
export function drawCoreCard(c, x, y, W, H) {
    if (!A || !coreUp()) return;
    const core = global.royale.core;
    const hot = core.hp < 0.5;
    const col = hot ? CORE_HOT : CORE;
    A.hudPanel(c, x, y, W, H, {});
    c.save();
    hexPath(c, x + 16, y + 13, 7, performance.now() / 700);
    c.fillStyle = col; c.fill();
    c.strokeStyle = A.HUD.ink; c.lineWidth = 2; c.stroke();
    c.restore();
    const gems = fmt(core.g || 0) + " gems";
    const gw = A.hudTitleW(gems, 12);
    let ns = 14; while (ns > 10 && A.hudTitleW("The Core", ns) > W - 40 - gw) ns -= 0.5;
    A.hudTitle("The Core", x + 28, y + 13, ns, col, "left");
    A.hudTitle(gems, x + W - 10, y + 13, 12, GOLD, "right");
    A.hudBar(c, x + 10, y + 22, W - 20, 8, core.hp, hot ? CORE_HOT : core.hp > 0.6 ? CORE : "#9ff6ff");
    const dist = Math.hypot(core.x - global.player.renderx, core.y - global.player.rendery);
    A.drawText(Math.round(core.hp * 100) + "%" + (hot ? "  ·  shards!" : ""), x + 12, y + H - 8, 9.5, hot ? CORE_HOT : A.HUD.text2, "left", true);
    A.drawText(A.fmtDist(dist) + " away", x + W - 12, y + H - 8, 9.5, A.HUD.text2, "right", true);
}
// the slim strip's version: a hex and a hp sliver, w wide
export function drawCoreMini(c, x, y, w) {
    if (!A || !coreUp()) return;
    const core = global.royale.core, col = core.hp < 0.5 ? CORE_HOT : CORE;
    c.save();
    hexPath(c, x + 6, y, 5, 0);
    c.fillStyle = col; c.fill();
    c.strokeStyle = A.HUD.ink; c.lineWidth = 1.5; c.stroke();
    c.restore();
    A.hudBar(c, x + 15, y - 3, w - 15, 6, core.hp, col);
}
// Lines for the notification stack under the clock (app.js hudNotes): the
// storm's last seconds (critical) and your hunted status, a compact badge.
const NOTE_CD = { pri: 0, key: "stormcd", text: "", col: "#b98bff", pulse: 0, badge: false };
const NOTE_HUNT = { pri: 1, key: "hunted", text: "", col: RED, pulse: 0, badge: true, sub: "" };
export function hudNotes(push) {
    const r = global.royale;
    if (!r || global.died) return;
    const st = r.storm;
    if (st && st.a && st.hold && !st.fin && (st.left | 0) > 0 && (st.left | 0) <= 5) {
        // the last seconds before the circle jumps: a pulsing count
        const n = st.left | 0;
        if (n !== S.cdLast) { S.cdLast = n; NOTE_CD.text = "Storm moves in " + n; try { if (gameSound.uiClick) gameSound.uiClick(); } catch (e) { /* */ } }
        NOTE_CD.pulse = 1 - (performance.now() / 1000) % 1;
        push(NOTE_CD);
    }
    if (S.mine) {
        const blink = calm() ? 1 : 0.72 + 0.28 * Math.sin(performance.now() / (S.threat > 0.5 ? 110 : 220));
        NOTE_HUNT.text = S.mine >= 2 ? "TOP TARGET" : "HUNTED";
        NOTE_HUNT.sub = S.hunters > 0 ? S.hunters + " near" : "bank to lose them";
        NOTE_HUNT.pulse = blink;
        push(NOTE_HUNT);
    }
}

// ── screen: vignettes and the slams ─────────────────────────────────────
export function drawScreen(c) {
    if (!A || !global.gameStart) return;
    juice.drawScreenFx(c);
    if (global.died) return;
    // falling in: the coach and the big cards wait for the landing
    if (skyDrop.falling()) global.hudCardUp = global.hudCardUp || "skydrop";
    const now = performance.now();
    const w = global.screenWidth, h = global.screenHeight;
    if (S.lowHp > 0.05 && A.vignetteSprite && juice.heavyOn() && juice.glowOn() && !juice.lightSafe() && juice.full()) {
        // chromatic edges: the frame splits red and cyan
        const k = S.lowHp, off = 5 + 6 * k;
        c.save();
        c.globalCompositeOperation = "lighter";
        c.globalAlpha = 0.22 * k;
        c.drawImage(A.vignetteSprite(w, h, 0.62, "255,30,60"), off, 0, w, h);
        c.drawImage(A.vignetteSprite(w, h, 0.62, "30,220,255"), -off, 0, w, h);
        c.restore();
    }
    if (S.lowHp > 0.05 && A.vignetteSprite && juice.glowOn()) {
        // the whole edge thumps red on the heartbeat you hear
        const beat = gameSound.satchelPulse ? gameSound.satchelPulse() : 0.5;
        const thump = juice.lightSafe() ? 0 : beat < 0.22 ? 1 - beat / 0.22 : 0;
        if (thump > 0.02) {
            c.save();
            c.globalAlpha = (juice.full() ? 0.3 : 0.18) * S.lowHp * thump;
            c.drawImage(A.vignetteSprite(w, h, 0.72, "200,10,30"), 0, 0, w, h);
            c.restore();
        }
    }
    const ha = now - S.hitAt;
    if (ha >= 0 && ha < 1500 && !lite()) drawHitCracks(c, w, h, 1 - ha / 1500);
    if (S.mine && juice.glowOn() && A.vignetteSprite) {
        // throbs on the heartbeat you hear
        const beat = gameSound.satchelPulse ? gameSound.satchelPulse() : 0.5;
        const thump = juice.lightSafe() ? 0 : beat < 0.18 ? 1 - beat / 0.18 : 0;
        const k = 0.12 + 0.06 * S.mine + 0.22 * S.threat + 0.12 * thump;
        c.save();
        c.globalAlpha = Math.min(0.62, k) * (juice.full() ? 1 : 0.6);
        c.drawImage(A.vignetteSprite(w, h, 0.62 - 0.12 * S.threat, RED_RGB), 0, 0, w, h);
        c.restore();
    }
    const sa = now - S.safeAt;
    if (sa < 900 && juice.glowOn() && A.vignetteSprite) {
        c.save();
        c.globalAlpha = 0.4 * (1 - sa / 900);
        c.drawImage(A.vignetteSprite(w, h, 0.5, "63,207,122"), 0, 0, w, h);
        c.restore();
    }
}
// a hard hit: thin glass cracks from the screen edge it came from, kept to
// the middle of that edge so they never sit on the corner HUD
function drawHitCracks(c, w, h, k) {
    const ca = Math.cos(S.hitAng), sa = Math.sin(S.hitAng);
    const tx = ca > 0 ? (w / 2) / ca : ca < 0 ? (-w / 2) / ca : Infinity;
    const ty = sa > 0 ? (h / 2) / sa : sa < 0 ? (-h / 2) / sa : Infinity;
    const t = Math.min(tx, ty);
    let ox = w / 2 + ca * t, oy = h / 2 + sa * t;
    ox = Math.max(w * 0.3, Math.min(w * 0.7, ox));
    oy = Math.max(h * 0.3, Math.min(h * 0.7, oy));
    if (tx < ty) ox = ca > 0 ? w : 0; else oy = sa > 0 ? h : 0;
    const R = Math.min(w, h) * 0.13;
    // point the cracks into the screen
    const inA = Math.atan2(h / 2 - oy, w / 2 - ox);
    const ra = Math.cos(inA), rb = Math.sin(inA);
    const set = hitCracks[S.hitSet];
    c.save();
    c.lineCap = "round"; c.lineJoin = "round";
    for (let pass = 0; pass < 2; pass++) {
        c.globalAlpha = (pass ? 0.6 : 0.35) * k;
        c.strokeStyle = pass ? "#ffffff" : "#120e15";
        c.lineWidth = pass ? 1.2 : 2.6;
        for (const p of set) {
            c.beginPath();
            c.moveTo(ox, oy);
            for (let i = 2; i < p.length; i += 2) {
                // fold every crack to the inward half, then turn it to face in
                const ux = Math.abs(p[i]), uy = p[i + 1];
                c.lineTo(ox + (ux * ra - uy * rb) * R, oy + (ux * rb + uy * ra) * R);
            }
            c.stroke();
        }
    }
    c.restore();
}
// y: the slam lane's centre line (app.js hudLanes)
export function drawSlams(c, y, k) {
    juice.drawSlams(c, global.screenWidth / 2, Math.round(y || global.screenHeight * 0.24), k);
}
export function slamUp() { return juice.slamUp(); }
export const SLAM_DROP = juice.SLAM_DROP;
// the bank milestones (MS) take a turn in the slam lane in a raid
export function slamBanked(title, bonus) {
    juice.slam(title + " BANKED", bonus ? bonus + " bonus" : "", GOLD, 2600, 54);
}

// ── kill feed / callout colours ────────────────────────────────────────
export function feedLine(f, who, tag) {
    if (f.bounty) return { text: tag(String(f.by || "Someone").slice(0, 13), GOLD) + " cashed the bounty on " + who(f.name, "someone"), badge: f.g ? { t: "+" + fmt(f.g), col: GOLD } : null };
    if (f.hunt) return { text: who(f.name, "Someone") + " is the top target", badge: { t: fmtK(f.g | 0), col: RED } };
    if (f.core && f.spawn) return { text: tag("The Core", CORE) + " has surfaced", badge: null };
    if (f.core && f.broke) return { text: (f.by ? tag(String(f.by).slice(0, 13), GOLD) : "Someone") + " broke " + tag("the Core", CORE), badge: f.g ? { t: "+" + fmt(f.g), col: GOLD } : null };
    if (f.core) return { text: who(f.name, "Someone") + " got shattered by " + tag("the Core", CORE), badge: null };
    return null;
}
export function calloutCol(kind) {
    switch (kind) {
        case "huntkill": return RED;
        case "rattler": case "rattlerdown": return ORANGE;
        case "escaped": return EMERALD;
        case "corebreak": return GOLD;
    }
    return null;
}

// QA (headless runs): what the client thinks is going on
window.dwSlams = () => juice.slamState();
window.dwHeat = () => ({ mine: S.mine, hunters: S.hunters, threat: +S.threat.toFixed(2), lowHp: +S.lowHp.toFixed(2), core: S.core, hunt: S.huntSrc, calm: !!global.hudCalm, tension: +tension().toFixed(2) });
