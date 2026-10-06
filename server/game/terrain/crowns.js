// Crowns: the raid's last storm, made loud
//
// When the raid's last storm starts, the top 3 tanks on the board get a
// crown
//
// hold a crowned tank earns PPS points a second (x SD_MULT in the last
//   steal      kill a crowned tank and its crown is yours, plus STEAL_FRAC
// of its kill and crown points, at most STEAL_CAP. Banked gems are never part of
//   one each   a killer who already wears a crown gets the points, and the
//              crown goes to the best uncrowned tank instead. One tank can't
//              sit on two crowns, so there are always three to chase
//   no killer  storm, a boss, the rock, a disconnect: the crown falls to the
//              highest-scoring uncrowned tank still alive
// final the last SUDDEN_MS: crowns pay double and every crown shows minute on
//
// The board and the raid end sort by points only
// Bots hold crowns too, so a quiet raid still has a fight at the end.
// Bot kills pay BOT_KILL_SHARE of a human kill (dig_royale scoreOf), so
// farming bots can't buy a win
//
// dig_royale.js owns the board; this file only knows tanks, stat keys and
// scores through attach(). Everything here is guarded there: a failure in
// here must never block the raid end.
//
// ROYALE_CROWNS=0 turns the whole thing off (old ending, final spawn lock).
'use strict';

const ON = process.env.ROYALE_CROWNS !== '0';
const SLOTS = 3;
const STEAL_FRAC = 0.3;
const STEAL_CAP = 1500;         // the most one steal can take
const PPS = 5;                  // points a second while you wear a crown
const SD_MULT = 2;              // ... in the final minute
const BELL_BONUS = 500;         // wearing one at the bell
const BOT_KILL_SHARE = 0.3;
const SUDDEN_MS = 60_000;
const TEN_MS = 10_000;
const MIN_LEFT_MS = 15_000;     // a contest needs at least this much raid left to start
const EVERY_MS = 250;
const FUZZ = 450;               // before sudden death the map shows this grid cell
const MAX_HUNTERS = 2;          // bots on one crowned human at once (controllers.js)
const CHAMP_MS = 24 * 60 * 60 * 1000;
// Crowns bank in the final minute too (see above)
const BANK_IN_SD = true;
// the vault rule a crown hears, in one place
const VAULT_RULE = "You can still bank, but the vault pushes a crown off as soon as it's done.";

let hooks = {};
let S = fresh();
function fresh() {
    return { on: false, at: 0, sd: false, ten: false, done: false, lastAt: 0, holders: [], n: 0 };
}

// dig_royale.js: keyOf(body), scoreOf(body), riskOf(body) (the points a steal can
// leftMs(t), live(), clients(), callout(body, kind, text, pts, sub, dur),
// feed(entry), fxAt(x, y, kind, ...), move(from, to, n), award(body, n)
function attach(h) { hooks = h || {}; }
function enabled() { return ON && !!(global.Config && Config.dig_royale) && !Config.tutorial && !Config.royale_duos; }
// bot kills: a share of a human kill (duos too, they have no contest but
// the same farming problem)
function botKillShare() { return ON && !!(global.Config && Config.dig_royale) && !Config.tutorial ? BOT_KILL_SHARE : 1; }

const alive = (b) => !!b && !b.isGhost && !(b.isDead && b.isDead());
const nameOf = (b) => String((b && b.name) || "Someone").slice(0, 24);
function eligible(b) {
    return alive(b) && (b.isPlayer || b.isBot) && !b.isRoyaleBoss && !b.adminSpec && !b.royaleFrozen && !b.sidekickOf;
}
function scoreOf(b) { try { return Math.max(0, +hooks.scoreOf(b) || 0); } catch { return 0; } }
function riskOf(b) {
    try { return Math.max(0, +(hooks.riskOf ? hooks.riskOf(b) : hooks.scoreOf(b)) || 0); } catch { return 0; }
}
// what killing this tank's crown takes from it right now Round 9 (bug 5): one
function stealFor(risk) { return Math.min(STEAL_CAP, Math.floor(Math.max(0, risk) * STEAL_FRAC / 10) * 10); }
function stealOf(b) {
    const risk = riskOf(b);
    if (b && b._crownRisk === risk && b._crownSteal != null) return b._crownSteal;
    const n = stealFor(risk);
    if (b) { b._crownRisk = risk; b._crownSteal = n; }
    return n;
}
// stealOf as a number: "-1,500 pts" style text for the crowned
function riskText(b) {
    const n = stealOf(b);
    return n > 0 ? "If they get you now, you lose " + fmt(n) + " pts, more as you earn (your crown card keeps count; banked gems are safe)." : "Your banked gems are safe if they get you.";
}
function keyOf(b) { try { return hooks.keyOf ? hooks.keyOf(b) : null; } catch { return null; } }
function holderOf(b) { return b ? S.holders.find(h => h.body === b) || null : null; }
function isCrowned(b) { return !!holderOf(b); }

function say(body, kind, text, sub, dur, pts = 0) {
    if (!body || !body.socket || !hooks.callout) return;
    // a crown that lands in the final minute: the vault rule, right away
    if (S.sd && BANK_IN_SD && (kind === 'crowned' || kind === 'crowntake')) sub = String(sub || "") + " Final minute: you can bank, but the vault won't hide you.";
    try { hooks.callout(body, kind, text, pts, sub, dur); } catch { /* */ }
}
// the same slam for everyone but `skip` (a Set of bodies)
function sayAll(kind, text, sub, dur, skip) {
    for (const c of (hooks.clients ? hooks.clients() : [])) {
        const b = c && c.player && c.player.body;
        if (skip && b && skip.has(b)) continue;
        try { c.talk('KC', String(kind), String(text), 0, String(sub || ""), dur | 0); } catch { /* */ }
    }
}
const fmt = (n) => (n | 0).toLocaleString('en-US');
const rate = () => PPS * (S.sd ? SD_MULT : 1);
const rateText = () => "+" + rate() + " pts/sec while you hold it";
function feed(e) { try { if (hooks.feed) hooks.feed(e); } catch { /* */ } }
function fx(b, kind) { try { if (hooks.fxAt && b) hooks.fxAt(b.x, b.y, kind, b.id | 0); } catch { /* */ } }

// points for holding: h.acc keeps the fractions between ticks why: 'bell' for the
function award(body, n, why) {
    if (!(n > 0) || !hooks.award) return 0;
    try { hooks.award(body, n, why); return n; } catch { return 0; }
}
function accrue(h, t) {
    const dt = Math.max(0, Math.min(1000, t - (h.at || t)));
    h.at = t;
    if (!eligible(h.body)) return;
    h.acc = (h.acc || 0) + dt * rate() / 1000;
    const n = Math.floor(h.acc);
    if (n <= 0) return;
    h.acc -= n;
    h.paid += award(h.body, n);
}

// how: why it's yours ('top3' at the start, 'steal', 'fell' from a holder who
function give(body, t, how = 'free', from = "") {
    S.holders.push({ body, key: keyOf(body), since: t, at: t, acc: 0, paid: 0, id: body.id, how, from: String(from || "").slice(0, 24) });
    body.crowned = true;
    body.crownLocked = S.sd;
    fx(body, 'crownon');
}
function drop(h) {
    S.holders = S.holders.filter(x => x !== h);
    if (h.body) { h.body.crowned = false; h.body.crownLocked = false; }
}

// the best uncrowned tank still standing, leaving out `skip`
function nextEligible(skip) {
    let best = null, bs = -1;
    for (const b of (hooks.fighters ? hooks.fighters() : [])) {
        if (!eligible(b) || holderOf(b) || (skip && skip.includes(b))) continue;
        const s = scoreOf(b);
        if (s > bs) { bs = s; best = b; }
    }
    return best;
}

function start(t) {
    S.on = true;
    S.at = t;
    S.n++;
    const cands = (hooks.fighters ? hooks.fighters() : []).filter(eligible)
        .map(b => ({ b, s: scoreOf(b) })).sort((a, c) => c.s - a.s).slice(0, SLOTS);
    for (const { b } of cands) give(b, t, 'top3');
    const crowned = new Set(cands.map(c => c.b));
    sayAll('crowns', "CROWNS ARE OUT", "Holding one earns points. Knock one off to steal it and " + Math.round(STEAL_FRAC * 100) + "% of their kill and crown points.", 5200, crowned);
    for (const b of crowned) say(b, 'crowned', "YOU GOT A CROWN", "You're top 3 on points: " + rateText() + ". Others will hunt you. " + riskText(b), 5200);
    feed({ crown: 1, start: 1, names: cands.map(c => nameOf(c.b)) });
}

// A crowned tank went down (dig_royale onCombatantDead). killer: the
// living tank that gets the credit, or null. -> what happened, or null
function onDeath(victim, killer, t = Date.now()) {
    if (!enabled() || !S.on || S.done) return null;
    const h = holderOf(victim);
    if (!h) return null;
    accrue(h, t);
    drop(h);
    const k = killer && killer !== victim && eligible(killer) ? killer : null;
    let stolen = 0;
    if (k) {
        stolen = stealOf(victim);
        if (stolen > 0 && hooks.move) { try { hooks.move(victim, k, stolen); } catch { stolen = 0; } }
    }
    let to = null, how = 'fall';
    if (k && !holderOf(k)) { to = k; how = 'steal'; }
    else { to = nextEligible([victim]); how = k ? 'pass' : 'fall'; }
    if (to) give(to, t, how === 'steal' ? 'steal' : 'fell', nameOf(victim));
    const vn = nameOf(victim), kn = k ? nameOf(k) : "", tn = to ? nameOf(to) : "";
    if (how === 'steal') {
        say(k, 'crowntake', "CROWN STOLEN", "You took " + vn + "'s crown: " + (stolen ? "+" + fmt(stolen) + " pts, " : "") + "+" + rate() + "/sec while you hold it.", 3600, stolen);
        say(victim, 'crownlost', "CROWN LOST", kn + " took your crown" + (stolen ? " and " + fmt(stolen) + " of your kill and crown points" : "") + ". Your banked gems are safe.", 3600);
        fx(k, 'crownsteal');
        feed({ crown: 1, took: 1, by: kn, name: vn, pts: stolen });
    } else {
        if (k) say(k, 'crowntake', "CROWN SMASHED", (stolen ? "+" + fmt(stolen) + " pts from " + vn + ". " : "") + "You already wear one, so it went to " + (tn || "nobody") + ".", 3400, stolen);
        say(victim, 'crownlost', "CROWN LOST", k ? kn + " knocked it off" + (stolen ? " and took " + fmt(stolen) + " of your kill and crown points" : "") + ". It went to " + (tn || "nobody") + "." : "You went down, so it fell to " + (tn || "nobody") + ". Go take it back.", 3400);
        if (to) say(to, 'crowned', "A CROWN FELL TO YOU", "Its holder " + vn + (k ? " was knocked out" : " died") + ". " + rateText() + ". " + riskText(to), 4600);
        feed(k ? { crown: 1, smash: 1, by: kn, name: vn, to: tn, pts: stolen } : { crown: 1, fell: 1, name: vn, to: tn });
    }
    return { how, stolen, to, killer: k };
}

// holders that left without a death (a disconnect, a despawn), and empty slots
function validate(t) {
    for (const h of S.holders.slice()) {
        if (eligible(h.body) && keyOf(h.body) === h.key) { h.goneAt = 0; continue; }
        // a death the raid hasn't booked yet: onDeath settles it (with the
        // killer) in a moment, don't hand the crown on early
        if (h.body && h.body.royaleAlive !== false && !h.body.isGhost) {
            if (!h.goneAt) h.goneAt = t;
            if (t - h.goneAt < 1500) continue;
        }
        drop(h);
        const to = nextEligible([h.body]);
        if (to) {
            give(to, t, 'left', nameOf(h.body));
            say(to, 'crowned', "A CROWN FELL TO YOU", "Its holder " + nameOf(h.body) + " left the raid. " + rateText() + ". " + riskText(to), 4600);
            feed({ crown: 1, fell: 1, name: nameOf(h.body), to: nameOf(to) });
        }
    }
    while (S.holders.length < SLOTS) {
        const to = nextEligible(null);
        if (!to) break;
        give(to, t, 'free');
        say(to, 'crowned', "YOU GOT A CROWN", "A crown was free and you're the best uncrowned tank. " + rateText() + ". " + riskText(to), 4600);
    }
}

function suddenDeath() {
    S.sd = true;
    global.royaleCrownSD = true;
    const crowned = new Set(S.holders.map(h => h.body));
    for (const b of crowned) {
        // crownLocked: the vault's no-hiding rule (vault.js), and bots keep fighting
        b.crownLocked = true;
        if (!BANK_IN_SD && b.vaultDeposit) { try { require('./vault.js').cancelDeposit(b, !!b.socket); } catch { /* */ } }
        say(b, 'suddendeath', "FINAL MINUTE", BANK_IN_SD
            ? "Your crown pays double now and everyone can see you. " + VAULT_RULE
            : "Your crown pays double now, but it can't bank and everyone can see you.", 4400);
    }
    sayAll('suddendeath', "FINAL MINUTE", "Crowns pay double and every crown is on the map. Go steal one!", 3800, crowned);
    feed({ crown: 1, sd: 1 });
}

function tenSeconds() {
    S.ten = true;
    for (const c of (hooks.clients ? hooks.clients() : [])) {
        const b = c && c.player && c.player.body;
        const mine = b && holderOf(b);
        try { c.talk('KC', 'crown10', "10 SECONDS", 0, mine ? "Hold on: wear it at the bell for +" + fmt(BELL_BONUS) + " pts." : "Take a crown now: +" + fmt(BELL_BONUS) + " pts if you wear it at the bell.", 2600); } catch { /* */ }
    }
}

function tick(t = Date.now()) {
    if (!enabled() || S.done) return;
    if (t - S.lastAt < EVERY_MS) return;
    S.lastAt = t;
    let left = Infinity;
    try { left = hooks.leftMs ? hooks.leftMs(t) : Infinity; } catch { /* */ }
    if (!S.on) {
        let fin = false;
        try { fin = !!(hooks.isFinal && hooks.isFinal()); } catch { /* */ }
        if (!fin || left < MIN_LEFT_MS || (hooks.live && !hooks.live())) return;
        start(t);
    }
    validate(t);
    for (const h of S.holders) accrue(h, t);
    if (!S.sd && left <= SUDDEN_MS) suddenDeath();
    if (!S.ten && left <= TEN_MS) tenSeconds();
    for (const h of S.holders) { h.body.crowned = true; h.body.crownLocked = S.sd; }
}

// Vault or base deposit: a message when it's refused, else null
function bankBlocked(body) {
    if (BANK_IN_SD || !enabled() || !S.on || !S.sd || S.done || !holderOf(body)) return null;
    return "Crowns can't bank in the final minute. Hold it for the points!";
}

// the stat keys wearing a crown right now (board rows `cr`)
function crownKeys() { return new Set(S.on ? S.holders.map(h => h.key).filter(Boolean) : []); }
// holder rows by score, best first: [{key, body, id, name, score, bot}]
function standings() {
    return S.holders.map(h => ({ key: h.key, body: h.body, id: h.id, name: nameOf(h.body), score: scoreOf(h.body), bot: !h.body.socket, paid: h.paid | 0 }))
        .sort((a, b) => b.score - a.score);
}

// raid end: the crowns stop moving and pay out (the last seconds, then BELL_BONUS
function finish(t = Date.now()) {
    if (!S.on || S.done) return [];
    for (const h of S.holders) {
        accrue(h, t);
        if (eligible(h.body)) h.paid += award(h.body, BELL_BONUS, 'bell');
    }
    const out = standings();
    S.done = true;
    return out;
}

// RY (shared): the crowns, best first. x/y are snapped to a FUZZ grid until
// sudden death (f: 1), then the real spot
function snapshot() {
    if (!enabled() || !S.on) return undefined;
    const list = [];
    for (const r of standings()) {
        const b = r.body;
        if (!alive(b) && !S.done) continue;
        let at = b;
        try { if (hooks.shownAt) at = hooks.shownAt(b) || b; } catch { /* */ }
        const fz = !S.sd && !S.done;
        list.push({
            e: r.id, n: r.name.slice(0, 16), s: r.score, p: r.paid, b: r.bot ? 1 : 0, f: fz ? 1 : 0, l: alive(b) ? stealOf(b) : 0,
            x: fz ? Math.round(at.x / FUZZ) * FUZZ : Math.round(at.x), y: fz ? Math.round(at.y / FUZZ) * FUZZ : Math.round(at.y),
        });
    }
    return { on: 1, sd: S.sd ? 1 : 0, done: S.done ? 1 : 0, fz: FUZZ, pps: rate(), bell: BELL_BONUS, steal: Math.round(STEAL_FRAC * 100), cap: STEAL_CAP, list };
}

function newRaid() {
    for (const h of S.holders) if (h.body) { h.body.crowned = false; h.body.crownLocked = false; }
    const n = S.n;
    S = fresh();
    S.n = n;
    global.royaleCrownSD = false;
}

function active() { return enabled() && S.on && !S.done; }
// RY you.crown: how you got yours and whose it was -> { how, from } | null
function howOf(b) { const h = holderOf(b); return h ? { how: h.how || 'free', from: h.from || "" } : null; }
function suddenOn() { return active() && S.sd; }
// a contest ran this raid (the raid end names a Core Champion)
function ran() { return enabled() && S.on; }

module.exports = {
    ON, SLOTS, STEAL_FRAC, STEAL_CAP, PPS, SD_MULT, BELL_BONUS, BOT_KILL_SHARE, SUDDEN_MS, TEN_MS, MIN_LEFT_MS, FUZZ, MAX_HUNTERS, CHAMP_MS, BANK_IN_SD, VAULT_RULE, howOf,
    attach, enabled, botKillShare, tick, onDeath, bankBlocked, crownKeys, standings, finish, snapshot, newRaid,
    active, suddenOn, ran, isCrowned, holderOf, stealOf, stealFor, riskText, rate,
    _state: () => S,
};
