// Contracts: every human in a raid always has one short job on the go (30 s
// to 2 min), picked from what is actually happening around them: a chest
// nearby, a full satchel and a safe vault, a fight, the boss, a bloom, the
// storm closing in. The job, its progress and where it points go out in the
// raid packet (RY you.obj); the client draws it as the contract card plus an
// arrow to the target.
//
// One at a time. A finished one pays (banked gems, which the board and growth
// count too, sometimes a kit item) and shows its result for a moment; then
// there's a 15 s breather (the card counts it down) before the next rolls
// done or missed. Two things skip the wait: a fresh spawn's first job comes
// within FIRST_ROLL_MS, and the safe-zone job turns up whenever the storm
// really has you. Players who go idle get none rolled and are never paid,
// and while the first-raid coach is running (the client says so with CO)
// the coach owns the screen instead.
//
// Revenge lives here too: whoever kills a human is marked for them until the
// raid clock runs a few minutes on, and taking them down pays a bonus.
//
// State is on the socket (sock.contract, sock.revenge), so it survives a
// death but not a new raid (reset()).
'use strict';

const activity = require('../network/activity.js');

const GAP_DONE_MS = 2200;      // a finished contract shows its result this long
const GAP_FAIL_MS = 1600;      // ...and a missed one this long
const COOLDOWN_MS = +process.env.ROYALE_CONTRACT_GAP_MS || 15_000;    // from the finish to the next roll (done or missed; round 9: was 30 s)
const FIRST_ROLL_MS = 1500;    // after a spawn: long enough for the tank to arrive, well inside 10 s
const IDLE_MS = 40_000;        // no real input for this long: nothing rolls, nothing pays
const FRESH_MS = 12_000;       // a life this young gets an easy contract near it
const REVENGE_MS = 4 * 60 * 1000;
const REVENGE_GEMS = 400;     // round 9: doubled (was 200)
const REVENGE_PTS = 400;
const TICK_MS = 250;
// The safe-zone job. "Safe" is the current circle less a small margin: where
// the edge will be ZONE_LEAD_MS from now, ZONE_MARGIN further in. It is only
// offered to someone who isn't safe by that same test (so it can never finish
// the moment it's offered), and it finishes as soon as they are.
const ZONE_LEAD_MS = 5000;
const ZONE_MARGIN = 100;
const ZONE_OUT_MS = 2000;      // right after a safe-zone job, only this long outside brings it back early
const ZONE_PAY_GAP_MS = 60_000; // the zone reward pays at most once in this long
const ZONE_SPEED = 110;        // a rough walking pace through rock (units/s), for "can they make it"

// Rewards (banked gems) and how long each kind runs.
const R = {
    chest: 150, chestEpic: 250, chestSupply: 250,
    bankShare: 0.15, bankMin: 60,
    mineShare: 0.5,
    boss: 300, streaker: 400, bounty: 300, bountySurvive: 300, hunt: 200,
    bloom: 80, event: 80, zone: 60, shop: 100,
};

let hooks = null;
let lastTickAt = 0;

// dig_royale.js hands over what the director needs from the raid.
//   pay(body, gems, why)          bank the reward (board + growth follow)
//   callout(body, kind, text, pts, sub, dur)
//   isNew(body)                   brand-new player
//   streakOf(body)                current kill streak
//   bounty()                      the pacing bounty or null: { body, until, gems }
//   inRaid()                      a raid is live (not between raids)
function attach(h) { hooks = h; }

function mods() {
    return {
        chests: require('./chests.js'), bosses: require('./bosses.js'), blooms: require('./blooms.js'),
        events: require('./raidEvents.js'), storm: require('./storm.js'), vault: require('./vault.js'),
        shop: require('./shop.js'),
    };
}

// ── helpers ─────────────────────────────────────────────────────────────
const DIRS = ["east", "southeast", "south", "southwest", "west", "northwest", "north", "northeast"];
function dirWord(dx, dy) {
    if (Math.hypot(dx, dy) < 450) return "nearby";
    const i = Math.round(((Math.atan2(dy, dx) + Math.PI * 2) % (Math.PI * 2)) / (Math.PI / 4)) % 8;
    return "to the " + DIRS[i];
}
const d2 = (a, x, y) => (a.x - x) ** 2 + (a.y - y) ** 2;
const alive = e => !!e && !(e.isDead && e.isDead()) && !e.isGhost;
// a chest job's chest is still there: alive, in the world, on the chest list, unopened
function chestValid(ch) {
    if (!alive(ch) || ch._opened || ch._cleared) return false;
    try { if (entities.get(ch.id) !== ch) return false; } catch { /* */ }
    try { if (!mods().chests.alive().includes(ch)) return false; } catch { /* */ }
    return true;
}
const round10 = n => Math.max(10, Math.round(n / 10) * 10);
const round50 = n => Math.max(50, Math.round(n / 50) * 50);

function idle(sock, t) {
    try { return activity.inputIdleMs(sock, t) > IDLE_MS; } catch { return false; }
}

function humans() {
    return (global.gameManager.socketManager?.players || [])
        .map(p => p && p.body)
        .filter(b => b && b.isPlayer && b.socket && alive(b));
}
function fighters() {
    const out = humans();
    for (const b of (global.gameManager.gameHandler?.bots || [])) if (alive(b)) out.push(b);
    return out;
}

function inZoneAhead(x, y, aheadMs, margin, t) {
    const { storm } = mods();
    try {
        const st = storm.snapshot(t);
        if (!st.a) return true;
        const r = storm.radius(t + aheadMs, true) - margin;
        return (x - st.cx) ** 2 + (y - st.cy) ** 2 <= Math.max(0, r) ** 2;
    } catch { return true; }
}

// The safe-zone job's line: { cx, cy, r, d } with d the body's distance
// from the centre, or null with no storm. Safe is d <= r.
function zoneLine(body, t) {
    const { storm } = mods();
    let st;
    try { st = storm.snapshot(t); } catch { return null; }
    if (!st.a) return null;
    const r = Math.max(0, storm.radius(t + ZONE_LEAD_MS, true) - ZONE_MARGIN);
    return { cx: st.cx, cy: st.cy, r, d: Math.hypot(body.x - st.cx, body.y - st.cy) };
}
function zoneSafe(body, t) {
    const z = zoneLine(body, t);
    return !z || z.d <= z.r;
}
// The nearest point a little inside the safe line.
function zonePoint(body, t) {
    const z = zoneLine(body, t);
    if (!z) return null;
    const r = Math.max(0, z.r - 150);
    const d = z.d || 1;
    if (d <= r) return { x: z.cx, y: z.cy };
    return { x: z.cx + (body.x - z.cx) / d * r, y: z.cy + (body.y - z.cy) / d * r };
}
// The raid's last storm (its closing hold and after): there's only so long
// left, so the job is only worth offering if they can get in before the end.
function zoneTimeLeft(t) {
    const { storm } = mods();
    try {
        if (!storm.isFinal()) return Infinity;
        const ph = storm.cyclePhase(t);
        if (ph !== 'hold' && ph !== 'done') return Infinity;
        return storm.endAt() - t;
    } catch { return Infinity; }
}

function nearestSafeVault(body, t) {
    const { vault } = mods();
    let best = null, bd = Infinity;
    for (const v of vault.getVaults()) {
        if (!inZoneAhead(v.x, v.y, 30_000, 0, t)) continue;
        const d = d2(v, body.x, body.y);
        if (d < bd) { bd = d; best = v; }
    }
    return best;
}
function nearestShop(body, t) {
    const { shop } = mods();
    let best = null, bd = Infinity;
    for (const s of shop.getShops()) {
        if (!inZoneAhead(s.x, s.y, 30_000, 0, t)) continue;
        const d = d2(s, body.x, body.y);
        if (d < bd) { bd = d; best = s; }
    }
    return best;
}

// ── candidates ──────────────────────────────────────────────────────────
// Each returns a contract (without id/timing) or null. `fresh`: the life is
// a few seconds old and wants something easy and close.
const MAKERS = {
    zone(body, t) {
        const z = zoneLine(body, t);
        // already safe (this is also what finishes it, so it can't loop)
        if (!z || z.d <= z.r) return null;
        // the last storm: skip it when there's no getting in before the end
        const left = zoneTimeLeft(t);
        if (left !== Infinity && (z.d - z.r) / ZONE_SPEED * 1000 + 2000 > left) return null;
        // stepping in and out never farms it: one payout a minute
        const paidAt = (body.socket && body.socket._zonePaidAt) || 0;
        const reward = paidAt && t - paidAt < ZONE_PAY_GAP_MS ? 0 : R.zone;
        return {
            kind: 'zone', pri: 100, text: "Get inside the safe zone", goal: 1, reward,
            ms: left === Infinity ? 45_000 : Math.max(5000, Math.min(45_000, left)), target: zonePoint(body, t), zone: 1,
        };
    },
    bountySurvive(body, t) {
        const b = hooks && hooks.bounty ? hooks.bounty() : null;
        if (!b || b.body !== body) return null;
        const left = b.until - t;
        if (left < 15_000) return null;
        return { kind: 'bountySurvive', pri: 95, text: "You're the bounty. Stay alive", goal: 1, reward: R.bountySurvive, ms: left, noArrow: true };
    },
    bank(body, t) {
        const carried = (body.carriedGems || 0) | 0;
        if (carried < 300) return null;
        const v = nearestSafeVault(body, t);
        if (!v) return null;
        const goal = round50(Math.min(carried * 0.8, 2000));
        const { storm } = mods();
        let text = "Bank " + goal.toLocaleString("en-US") + " gems";
        let ms = 75_000;
        try {
            const st = storm.snapshot(t);
            if (st.hold && st.left > 30 && !st.fin) { ms = Math.min(120_000, st.left * 1000); text += " before the storm moves"; }
        } catch { /* */ }
        return {
            kind: 'bank', pri: 70 + Math.min(20, carried / 100), text, goal, reward: round10(Math.max(R.bankMin, goal * R.bankShare)), ms,
            target: { x: v.x, y: v.y, r: (v.r || 95) * 1.45 }, base: (body.socket.gemDeposited || 0),
        };
    },
    boss(body, t, fresh) {
        if (fresh) return null;
        const { bosses } = mods();
        const b = bosses.current();
        if (!b || d2(b, body.x, body.y) > 2600 * 2600) return null;
        const max = (b.health && b.health.max) || 1;
        return {
            kind: 'boss', pri: 65, text: "Chip 10% off the " + (b.name || "boss"), goal: Math.round(max * 0.1), reward: R.boss, kit: true, ms: 120_000,
            ent: b, base: bosses.damageBy ? bosses.damageBy(body) : 0,
        };
    },
    bounty(body, t, fresh) {
        const b = hooks && hooks.bounty ? hooks.bounty() : null;
        if (!b || !alive(b.body) || b.body === body || b.body.team === body.team) return null;
        if (b.until - t < 20_000 || d2(b.body, body.x, body.y) > 3000 * 3000) return null;
        if (fresh && hooks.isNew && hooks.isNew(body)) return null;
        if (hooks.tooStrong && hooks.tooStrong(body, b.body)) return null;
        return { kind: 'bounty', pri: 66, text: "Claim the bounty on " + (b.body.name || "Unnamed"), goal: 1, reward: R.bounty, ms: b.until - t, ent: b.body };
    },
    streaker(body, t, fresh) {
        if (fresh) return null;
        let best = null, bd = 2800 * 2800;
        for (const f of fighters()) {
            if (f === body || f.team === body.team) continue;
            const n = hooks && hooks.streakOf ? hooks.streakOf(f) : 0;
            if (n < 4) continue;
            if (hooks && hooks.tooStrong && hooks.tooStrong(body, f)) continue;
            const d = d2(f, body.x, body.y);
            if (d < bd) { bd = d; best = { f, n }; }
        }
        if (!best) return null;
        return { kind: 'streaker', pri: 60, text: "Take down " + (best.f.name || "the streaker") + " (" + best.n + " streak)", goal: 1, reward: R.streaker, ms: 120_000, ent: best.f };
    },
    hunt(body, t, fresh) {
        const cut = t - 5000;
        const hot = b => Math.max(b._lastDamageAt || 0, b.hitAt || 0) > cut;
        const newbie = hooks && hooks.isNew && hooks.isNew(body);
        let best = null, bd = 1000 * 1000;
        for (const f of fighters()) {
            if (f === body || f.team === body.team || f.isRoyaleBoss) continue;
            const d = d2(f, body.x, body.y);
            if (d >= bd) continue;
            // someone near you and one of you is in a fight; a brand-new
            // player only gets this once they are the one being hit
            if (newbie ? !hot(body) : !(hot(body) || hot(f))) continue;
            if (hooks && hooks.tooStrong && hooks.tooStrong(body, f)) continue;
            bd = d; best = f;
        }
        if (!best) return null;
        return { kind: 'hunt', pri: 58, text: "Take down " + (best.name || "Unnamed"), goal: 1, reward: R.hunt, ms: 60_000, ent: best };
    },
    bloom(body, t) {
        const { blooms } = mods();
        const b = blooms.current();
        if (!b || b.until - t < 25_000) return null;
        const d = Math.hypot(b.x - body.x, b.y - body.y);
        if (d < b.r || d > 3200) return null;
        return { kind: 'bloom', pri: 55, text: "Get to the ore bloom " + dirWord(b.x - body.x, b.y - body.y), goal: 1, reward: R.bloom, ms: Math.min(70_000, b.until - t), target: { x: b.x, y: b.y, r: b.r * 0.8 } };
    },
    event(body, t) {
        const { events } = mods();
        const ev = events.current();
        if (!ev || ev.until - t < 12_000) return null;
        const d = Math.hypot(ev.x - body.x, ev.y - body.y);
        if (d < ev.r * 0.8 || d > 3200) return null;
        const what = ev.kind === 'rain' ? "the gem rain" : "the meteor shower";
        return { kind: 'event', pri: 56, text: "Get under " + what, goal: 1, reward: R.event, ms: ev.until - t, target: { x: ev.x, y: ev.y, r: ev.r * 0.8 } };
    },
    chest(body, t, fresh, plan) {
        const { chests, storm } = mods();
        // the death screen promised a chest: look a bit farther for one
        const reach = fresh ? (plan === 'chest' ? 1900 : 1300) : 1700;
        let best = null, bs = Infinity;
        for (const c of chests.alive()) {
            if (!chestValid(c)) continue;
            const d = Math.hypot(c.x - body.x, c.y - body.y);
            if (d > reach) continue;
            try { if (storm.inStorm(c.x, c.y, t)) continue; } catch { /* */ }
            // supply drops and epics are worth a detour
            const score = d - (c.supplyDrop ? 500 : c.chestRare ? 200 : 0);
            if (score < bs) { bs = score; best = c; }
        }
        if (!best) return null;
        const name = best.supplyDrop ? "the supply drop" : best.chestRare ? "the epic chest" : "the copper chest";
        const reward = best.supplyDrop ? R.chestSupply : best.chestRare ? R.chestEpic : R.chest;
        const d = Math.hypot(best.x - body.x, best.y - body.y);
        return {
            kind: 'chest', pri: (fresh ? 75 : 50) + (best.supplyDrop ? 12 : 0), text: "Open " + name + " " + dirWord(best.x - body.x, best.y - body.y),
            goal: 1, reward, ms: Math.round(Math.min(110_000, 50_000 + d * 30)), ent: best,
        };
    },
    shop(body, t, fresh) {
        const { shop } = mods();
        const s = shop.stateOf(body.socket);
        const banked = (body.socket.gemBanked || 0) | 0;
        if (!s || (s.spent | 0) > 0 || banked < 300) return null;
        const pad = nearestShop(body, t);
        if (!pad) return null;
        const medkit = !((s.kit && s.kit.medkit) | 0);
        return {
            kind: 'shop', pri: fresh ? 40 : 48, text: medkit ? "Buy a Medkit at a shop" : "Buy something at a shop", goal: 1, reward: R.shop, ms: 90_000,
            target: { x: pad.x, y: pad.y, r: (pad.r || 95) * 1.45 }, item: medkit ? 'medkit' : null,
        };
    },
    mine(body, t, fresh) {
        const goal = fresh ? 80 : 60 + 20 * ((Math.random() * 6) | 0);
        const ms = fresh ? 40_000 : 45_000 + (goal - 60) * 150;
        return {
            kind: 'mine', pri: 20, text: "Mine " + goal + " gems", goal, reward: round10(goal * R.mineShare), ms,
            target: nearestOre(body, fresh ? 900 : 1300) || nearestOre(body, 2400), lastCarried: (body.carriedGems || 0) | 0,
        };
    },
};
// kinds a few-seconds-old life may get
const FRESH_KINDS = ['zone', 'chest', 'shop', 'mine'];

// Nearest ore rock (once per roll): the mine contract's arrow.
function nearestOre(body, maxD) {
    const tg = global.gameManager.terrainGrid;
    if (!tg || !tg.rocks) return null;
    let best = null, bd = maxD * maxD;
    for (const rock of tg.rocks.values()) {
        if (!rock || !rock.alive || !((rock.ore | 0) >= 1) || rock.ore === 4) continue;
        const x = rock.worldCx || rock.wx, y = rock.worldCy || rock.wy;
        const d = (x - body.x) ** 2 + (y - body.y) ** 2;
        if (d < bd) { bd = d; best = { x, y, r: 200, ore: 1 }; }
    }
    return best;
}

let seq = 0;
function roll(body, t, plan) {
    const sock = body.socket;
    const fresh = body.royaleBornAt ? t - body.royaleBornAt < FRESH_MS : true;
    const kinds = fresh ? FRESH_KINDS : Object.keys(MAKERS);
    const cands = [];
    for (const k of kinds) {
        let c = null;
        try { c = MAKERS[k](body, t, fresh, plan); } catch (e) { c = null; }
        if (!c) continue;
        // the same kind twice in a row is less likely, unless it's urgent
        if (sock._contractLastKind === c.kind && c.pri < 90) c.pri *= 0.55;
        if (plan && plan === c.kind) c.pri += 30;
        cands.push(c);
    }
    if (!cands.length) return null;
    cands.sort((a, b) => b.pri - a.pri);
    // urgent ones and a fresh spawn's first job take the best fit; otherwise a
    // weighted pick among the close runners-up, for variety
    let pick = cands[0];
    if (pick.pri < 90 && !fresh && cands.length > 1) {
        const top = cands.slice(0, 3).filter(c => c.pri >= pick.pri - 25);
        let sum = 0;
        for (const c of top) sum += c.pri * c.pri;
        let r = Math.random() * sum;
        for (const c of top) { r -= c.pri * c.pri; if (r <= 0) { pick = c; break; } }
    }
    pick.id = ++seq;
    pick.at = t;
    pick.until = t + Math.max(20_000, pick.ms | 0);
    pick.prog = 0;
    pick.state = 0;        // 0 active, 1 done, 2 missed
    sock._contractLastKind = pick.kind;
    return pick;
}

// ── progress ────────────────────────────────────────────────────────────
// Returns 'done', a fail reason, or null (still going).
function update(c, body, t) {
    const sock = body.socket;
    switch (c.kind) {
        case 'zone': {
            if (zoneSafe(body, t)) return 'done';
            c.target = zonePoint(body, t);
            break;
        }
        case 'bountySurvive': {
            const b = hooks && hooks.bounty ? hooks.bounty() : null;
            if (!b || b.body !== body) return t >= c.until - 500 ? 'done' : 'The bounty was lifted';
            c.prog = Math.min(0.999, (t - c.at) / Math.max(1, c.until - c.at));
            if (t >= c.until - 250) return 'done';
            break;
        }
        case 'bank': {
            c.prog = Math.max(0, Math.floor((sock.gemDeposited || 0) - c.base + 1e-6));
            if (c.prog >= c.goal) return 'done';
            const v = nearestSafeVault(body, t);
            if (v) c.target = { x: v.x, y: v.y, r: (v.r || 95) * 1.45 };
            // nothing left to bank
            if (((body.carriedGems || 0) | 0) < 10 && c.prog < c.goal && !body.vaultDeposit) return 'Your satchel is empty';
            break;
        }
        case 'mine': {
            const now = (body.carriedGems || 0) | 0;
            if (now > c.lastCarried) c.prog += now - c.lastCarried;
            c.lastCarried = now;
            if (c.target && d2(c.target, body.x, body.y) < 220 * 220) c.target = null;
            if (c.prog >= c.goal) return 'done';
            break;
        }
        case 'boss': {
            const { bosses } = mods();
            const dealt = (bosses.damageBy ? bosses.damageBy(body) : 0) - c.base;
            c.prog = Math.max(0, Math.round(dealt));
            if (c.prog >= c.goal) return 'done';
            if (!alive(c.ent) || bosses.current() !== c.ent) return 'The boss is gone';
            break;
        }
        case 'chest': {
            const ch = c.ent;
            if (c.hit === 1) return 'done';
            if (!chestValid(ch)) return ch && ch._opened && !ch._retired && !ch._cleared ? 'Someone else got it' : 'The chest is gone';
            const max = (ch.health && ch.health.max) || 1;
            c.prog = Math.max(0, Math.min(0.99, 1 - ch.health.amount / max));
            break;
        }
        case 'bounty': case 'streaker': case 'hunt': {
            if (c.hit === 1) return 'done';
            const e = c.ent;
            if (!alive(e)) return 'Someone else got them';
            if (c.kind === 'bounty') {
                const b = hooks && hooks.bounty ? hooks.bounty() : null;
                if (!b || b.body !== e) return 'The bounty was lifted';
            }
            if (c.kind === 'hunt' && d2(e, body.x, body.y) > 2400 * 2400) return 'They got away';
            const max = (e.health && e.health.max) || 1;
            c.prog = Math.max(0, Math.min(0.99, 1 - e.health.amount / max));
            break;
        }
        case 'bloom': {
            const { blooms } = mods();
            const b = blooms.current();
            if (!b) return 'The bloom faded';
            c.target = { x: b.x, y: b.y, r: b.r * 0.8 };
            if (d2(b, body.x, body.y) <= (b.r * 0.8) ** 2) return 'done';
            break;
        }
        case 'event': {
            const { events } = mods();
            const ev = events.current();
            if (!ev) return "It's over";
            if (d2(ev, body.x, body.y) <= (ev.r * 0.8) ** 2) return 'done';
            break;
        }
        case 'shop': {
            if (c.hit === 1) return 'done';
            const pad = nearestShop(body, t);
            if (pad) c.target = { x: pad.x, y: pad.y, r: (pad.r || 95) * 1.45 };
            break;
        }
    }
    if (t >= c.until) return "Time's up";
    return null;
}

function finish(body, c, t, ok, why) {
    const sock = body.socket;
    c.state = ok ? 1 : 2;
    c.why = ok ? "" : String(why || "Missed");
    c.endAt = t;
    // the breather before the next one, whichever way this went
    sock.contractNextAt = t + COOLDOWN_MS;
    if (!ok) return;
    // never paid to someone who stopped playing (checked by the caller too)
    if (idle(sock, t)) { c.state = 2; c.why = "Missed"; return; }
    if (c.paid) return;
    c.paid = true;
    if (c.kind === 'zone') {
        if (!(c.reward > 0)) return;
        sock._zonePaidAt = t;
    }
    // the bounty pays through pacing.js (its own callout); the card just shows it done
    if (c.kind === 'bounty' || c.kind === 'bountySurvive') return;
    sock.contractsDone = (sock.contractsDone | 0) + 1;
    let kitName = "";
    if (c.kit) {
        try {
            const shop = mods().shop;
            const id = shop.randomKitId();
            if (shop.grantKit(sock, id)) kitName = (shop.BY_ID.get(id) || {}).name || "";
        } catch { /* */ }
    }
    // the bank pop says what paid: "+250 banked: contract: Open the chest"
    try { if (hooks && hooks.pay) hooks.pay(body, c.reward, "contract: " + String(c.text || c.kind || "done").slice(0, 38)); } catch { /* */ }
    const sub = "+" + c.reward.toLocaleString("en-US") + " gems" + (kitName ? " and a " + kitName : "");
    try { if (hooks && hooks.callout) hooks.callout(body, "contract", "Contract done", 0, sub); } catch { /* */ }
}

// ── per tick ────────────────────────────────────────────────────────────
function tick(t = Date.now()) {
    // (a clock that stepped back never stalls it)
    if (t - lastTickAt < TICK_MS && t >= lastTickAt) return;
    lastTickAt = t;
    if (!hooks || (hooks.inRaid && !hooks.inRaid())) return;
    for (const body of humans()) {
        const sock = body.socket;
        if (!sock || body.royaleFrozen) continue;
        // the coach owns the screen; nothing is running for them meanwhile
        if (sock.coachOn) {
            sock.contract = null;
            // the coach handing over is a fresh start: no breather after it
            if ((sock.contractNextAt || 0) > t + FIRST_ROLL_MS) sock.contractNextAt = t + FIRST_ROLL_MS;
            if (sock._dropCue && t >= (sock.contractNextAt || 0)) {
                sock._dropCue = false;
                try { hooks.callout(body, "dropin", "Drop in!", 0, "", 2000); } catch { /* */ }
            }
            continue;
        }
        const isIdle = idle(sock, t);
        let c = sock.contract;
        if (c && c.state === 0) {
            if (isIdle) { finish(body, c, t, false, "You went idle"); continue; }
            let res = null;
            try { res = update(c, body, t); } catch (e) { res = null; }
            if (res === 'done') finish(body, c, t, true);
            else if (res) finish(body, c, t, false, res);
            continue;
        }
        if (isIdle) continue;
        let next = null;
        if (t < (sock.contractNextAt || 0)) {
            // the breather; only the storm actually having you cuts it short
            next = zoneInterrupt(body, c, t);
            if (!next) continue;
        } else next = roll(body, t, sock.contractPlan);
        if (!next || !next.early) sock.contractPlan = null;
        sock.contract = next;
        if (!next) { sock.contractNextAt = t + 3000; continue; }
        if (sock._dropCue) {
            sock._dropCue = false;
            try { hooks.callout(body, "dropin", "Drop in!", 0, next.text, 2800); } catch { /* */ }
        }
    }
}

// During the breather: the safe-zone job, if the storm really has them.
// Right after a safe-zone job (done or missed) the edge closing in again
// waits for the breather like anything else; only being properly outside
// (ZONE_OUT_MS in the storm) after a done one brings it back sooner, so a
// miss never re-offers itself in a loop.
function zoneInterrupt(body, last, t) {
    const sock = body.socket;
    const { storm } = mods();
    let out = false;
    try { out = storm.inStorm(body.x, body.y, t); } catch { out = false; }
    if (out) { if (!sock._zoneOutSince) sock._zoneOutSince = t; }
    else sock._zoneOutSince = 0;
    // let the last result show first
    if (last && t - (last.endAt || 0) < (last.state === 1 ? GAP_DONE_MS : GAP_FAIL_MS)) return null;
    if (last && last.kind === 'zone') {
        if (last.state !== 1) return null;
        if (!out || t - sock._zoneOutSince < ZONE_OUT_MS) return null;
    }
    let c = null;
    try { c = MAKERS.zone(body, t); } catch { c = null; }
    if (!c) return null;
    c.id = ++seq; c.at = t; c.until = t + Math.max(20_000, c.ms | 0); c.prog = 0; c.state = 0;
    c.early = true;
    sock._contractLastKind = c.kind;
    return c;
}

// ── events from the raid ────────────────────────────────────────────────
function onSpawn(body, t = Date.now()) {
    const sock = body && body.socket;
    if (!sock) return;
    sock.contract = null;
    sock.contractNextAt = t + FIRST_ROLL_MS;
    sock._dropCue = true;
}

// The next contract a dead player will get, for the death screen.
function planFor(sock) {
    const { chests } = mods();
    let hasChest = false;
    try { hasChest = chests.alive().some(c => c && !c._opened); } catch { /* */ }
    sock.contractPlan = hasChest ? 'chest' : 'mine';
    return hasChest ? "Open a chest near where you land" : "Mine some gems near where you land";
}

function onDeath(body, killer, t = Date.now()) {
    const sock = body && body.socket;
    if (sock) {
        const c = sock.contract;
        if (c && c.state === 0) { c.state = 2; c.why = "You died"; c.endAt = t; }
        sock.contract = null;
        sock.contractNext = planFor(sock);
        // revenge: a player or bot that took you down is yours to find
        if (killer && killer !== body && (killer.isPlayer || killer.isBot) && !killer.isRoyaleBoss && killer.team !== body.team) {
            sock.revenge = { key: hooks && hooks.keyOf ? hooks.keyOf(killer) : null, id: killer.id, name: killer.name || "Unnamed", until: t + REVENGE_MS };
        }
    }
    // whoever held a contract on this body and did not land the kill misses it
}

// A kill: contracts on the victim complete for the killer. Returns true when
// it was the killer's revenge (dig_royale pays that and says so).
function onKill(killer, victim, t = Date.now()) {
    const sock = killer && killer.socket;
    if (!sock) return false;
    const c = sock.contract;
    if (c && c.state === 0 && c.ent === victim && (c.kind === 'hunt' || c.kind === 'streaker' || c.kind === 'bounty')) c.hit = 1;
    const rv = sock.revenge;
    if (!rv || rv.until < t) return false;
    const key = hooks && hooks.keyOf ? hooks.keyOf(victim) : null;
    if (rv.id !== victim.id && !(rv.key && key && rv.key === key)) return false;
    sock.revenge = null;
    return true;
}

function onChestOpened(body, chest) {
    const c = body && body.socket && body.socket.contract;
    if (c && c.state === 0 && c.kind === 'chest' && c.ent === chest) c.hit = 1;
}

function onShopBuy(body, item) {
    const c = body && body.socket && body.socket.contract;
    if (!c || c.state !== 0 || c.kind !== 'shop') return;
    if (!c.item || (item && item.id === c.item)) c.hit = 1;
}

// ── snapshots (RY) ──────────────────────────────────────────────────────
function snapshotFor(sock, body, t = Date.now()) {
    const c = sock && sock.contract;
    if (!c) return null;
    // the result shows for a moment, then the card counts down the breather
    // (st 3, ms to go); nothing at all for someone idle
    if (c.state !== 0 && t - (c.endAt || 0) > (c.state === 1 ? GAP_DONE_MS : GAP_FAIL_MS) + 400) {
        const wait = (sock.contractNextAt || 0) - t;
        if (wait <= 0 || idle(sock, t)) return null;
        return { id: c.id, k: c.kind, st: 3, ms: Math.round(wait) };
    }
    const out = { id: c.id, k: c.kind, t: c.text, p: c.prog, g: c.goal, r: c.reward, ms: Math.max(0, c.until - t), st: c.state };
    if (c.zone) out.z = 1;
    if (c.why) out.why = c.why;
    if (c.state === 0 && !c.noArrow) {
        const e = c.ent;
        if (e && (c.kind === 'chest' ? chestValid(e) : alive(e))) { out.x = Math.round(e.x); out.y = Math.round(e.y); out.e = e.id; }
        else if (c.target) { out.x = Math.round(c.target.x); out.y = Math.round(c.target.y); if (c.target.r) out.tr = Math.round(c.target.r); }
    }
    return out;
}

// { alive, x, y, e, name, hp } for the client's revenge marks, or null.
function revengeFor(sock, bodyByKey, t = Date.now()) {
    const rv = sock && sock.revenge;
    if (!rv) return null;
    if (rv.until < t) { sock.revenge = null; return null; }
    let b = null;
    try { b = entities.get(rv.id); } catch { b = null; }
    if (!alive(b) && rv.key && bodyByKey) b = bodyByKey.get(rv.key) || null;
    if (!alive(b)) return { alive: 0, name: rv.name };
    rv.id = b.id;
    const hp = b.health && b.health.max ? Math.max(0, Math.min(1, b.health.amount / b.health.max)) : 1;
    let at = b;
    try { at = require('./abilities.js').shownAt(b); } catch { at = b; }     // smoke: where it went in
    return { alive: 1, x: Math.round(at.x), y: Math.round(at.y), e: b.id, name: b.name || rv.name, hp: Math.round(hp * 100) / 100, bonus: REVENGE_GEMS };
}

function reset() {
    lastTickAt = 0;
    for (const c of (global.gameManager.socketManager?.clients || [])) {
        if (!c) continue;
        c.contract = null;
        c.contractNextAt = 0;
        c.contractPlan = null;
        c.contractNext = null;
        c.revenge = null;
        c._contractLastKind = null;
        c._zonePaidAt = 0;
        c._zoneOutSince = 0;
    }
}

module.exports = {
    attach, tick, onSpawn, onDeath, onKill, onChestOpened, onShopBuy, snapshotFor, revengeFor, reset,
    MAKERS, REWARDS: R, REVENGE_GEMS, REVENGE_PTS, IDLE_MS, FRESH_MS, FIRST_ROLL_MS, COOLDOWN_MS,
    ZONE_LEAD_MS, ZONE_MARGIN, ZONE_OUT_MS, ZONE_PAY_GAP_MS,
    // tests
    _roll: roll, _update: update,
    // DBG contract <kind>: force that kind now (null if it can't happen here)
    debugForce(body, kind, t = Date.now()) {
        const make = MAKERS[kind];
        if (!make || !body || !body.socket) return null;
        const c = make(body, t, false);
        if (!c) return null;
        c.id = ++seq; c.at = t; c.until = t + Math.max(20_000, c.ms | 0); c.prog = 0; c.state = 0;
        body.socket.contract = c;
        return c.text;
    },
};
