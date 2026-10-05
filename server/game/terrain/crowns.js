// The Crown Contest: how a raid is won.
//
// When the raid's last storm starts, the top 3 tanks on the board get a
// crown. Only a crowned tank can win: when the raid ends, the crown holder
// with the most points is the Core Champion and the other two take 2nd and
// 3rd. Everyone else places after them by score.
//
//   steal      kill a crowned tank and its crown is yours, plus STEAL_FRAC
//              of its points (board only, ranked never sees the swing)
//   one each   a killer who already wears a crown gets the points, and the
//              crown goes to the best uncrowned tank instead. One tank can't
//              sit on two crowns, so there are always three to chase
//   no killer  storm, a boss, the rock, a disconnect: the crown falls to the
//              highest-scoring uncrowned tank still alive
//   sudden     the last SUDDEN_MS: crowns can't bank and every crown shows
//   death      on everyone's map at its real spot (before that the map only
//              shows the area it's in)
//
// Bots hold crowns too, so a quiet raid still has a fight at the end.
// Bot kills pay BOT_KILL_SHARE of a human kill (dig_royale scoreOf), so
// farming bots can't buy a crown.
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
const BOT_KILL_SHARE = 0.3;
const SUDDEN_MS = 60_000;
const TEN_MS = 10_000;
const MIN_LEFT_MS = 15_000;     // a contest needs at least this much raid left to start
const EVERY_MS = 250;
const FUZZ = 450;               // before sudden death the map shows this grid cell
const MAX_HUNTERS = 2;          // bots on one crowned human at once (controllers.js)
const CHAMP_MS = 24 * 60 * 60 * 1000;

let hooks = {};
let S = fresh();
function fresh() {
    return { on: false, at: 0, sd: false, ten: false, done: false, lastAt: 0, holders: [], n: 0 };
}

// dig_royale.js: keyOf(body), scoreOf(body), fighters(), isFinal(),
// leftMs(t), live(), clients(), callout(body, kind, text, pts, sub, dur),
// feed(entry), fxAt(x, y, kind, ...), move(from, to, n), shownAt(body)
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
function keyOf(b) { try { return hooks.keyOf ? hooks.keyOf(b) : null; } catch { return null; } }
function holderOf(b) { return b ? S.holders.find(h => h.body === b) || null : null; }
function isCrowned(b) { return !!holderOf(b); }

function say(body, kind, text, sub, dur, pts = 0) {
    if (!body || !body.socket || !hooks.callout) return;
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
function feed(e) { try { if (hooks.feed) hooks.feed(e); } catch { /* */ } }
function fx(b, kind) { try { if (hooks.fxAt && b) hooks.fxAt(b.x, b.y, kind, b.id | 0); } catch { /* */ } }

function give(body, t) {
    S.holders.push({ body, key: keyOf(body), since: t, id: body.id });
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
    for (const { b } of cands) give(b, t);
    const crowned = new Set(cands.map(c => c.b));
    sayAll('crowns', "THE CROWN CONTEST", "The top 3 hold crowns. Take one to win.", 5200, crowned);
    for (const b of crowned) say(b, 'crowned', "YOU HOLD A CROWN", "Keep it to the bell and you win. Everyone's coming for it.", 4200);
    feed({ crown: 1, start: 1, names: cands.map(c => nameOf(c.b)) });
}

// A crowned tank went down (dig_royale onCombatantDead). killer: the
// living tank that gets the credit, or null. -> what happened, or null
function onDeath(victim, killer, t = Date.now()) {
    if (!enabled() || !S.on || S.done) return null;
    const h = holderOf(victim);
    if (!h) return null;
    drop(h);
    const k = killer && killer !== victim && eligible(killer) ? killer : null;
    let stolen = 0;
    if (k) {
        stolen = Math.floor(scoreOf(victim) * STEAL_FRAC / 10) * 10;
        if (stolen > 0 && hooks.move) { try { hooks.move(victim, k, stolen); } catch { stolen = 0; } }
    }
    let to = null, how = 'fall';
    if (k && !holderOf(k)) { to = k; how = 'steal'; }
    else { to = nextEligible([victim]); how = k ? 'pass' : 'fall'; }
    if (to) give(to, t);
    const vn = nameOf(victim), kn = k ? nameOf(k) : "", tn = to ? nameOf(to) : "";
    const pts = stolen ? "+" + stolen.toLocaleString('en-US') + " pts" : "";
    if (how === 'steal') {
        say(k, 'crowntake', "CROWN STOLEN", (pts ? pts + " from " : "From ") + vn + ". Now keep it.", 3400, stolen);
        say(victim, 'crownlost', "CROWN LOST", kn + " took it" + (stolen ? " and " + stolen.toLocaleString('en-US') + " of your points" : "") + ". Take it back!", 3400);
        fx(k, 'crownsteal');
        feed({ crown: 1, took: 1, by: kn, name: vn, pts: stolen });
    } else {
        if (k) say(k, 'crowntake', "CROWN SMASHED", (pts ? pts + ". " : "") + "One crown each, so " + (tn || "nobody") + " gets it.", 3000, stolen);
        say(victim, 'crownlost', "CROWN LOST", k ? kn + " smashed it. Get another one!" : "It fell to " + (tn || "nobody") + ". Go take it back!", 3200);
        if (to) say(to, 'crowned', "A CROWN FELL TO YOU", vn + " dropped it. Keep it to the bell.", 3400);
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
            give(to, t);
            say(to, 'crowned', "A CROWN FELL TO YOU", nameOf(h.body) + " is gone. Keep it to the bell.", 3400);
            feed({ crown: 1, fell: 1, name: nameOf(h.body), to: nameOf(to) });
        }
    }
    while (S.holders.length < SLOTS) {
        const to = nextEligible(null);
        if (!to) break;
        give(to, t);
        say(to, 'crowned', "YOU HOLD A CROWN", "Keep it to the bell and you win.", 3400);
    }
}

function suddenDeath() {
    S.sd = true;
    global.royaleCrownSD = true;
    const crowned = new Set(S.holders.map(h => h.body));
    for (const b of crowned) {
        b.crownLocked = true;
        // a deposit in progress stops right here
        if (b.vaultDeposit) { try { require('./vault.js').cancelDeposit(b, !!b.socket); } catch { /* */ } }
        say(b, 'suddendeath', "SUDDEN DEATH", "Crowns can't bank now. Everyone can see you. Survive!", 3800);
    }
    sayAll('suddendeath', "SUDDEN DEATH", "Crowns can't bank. Every crown is on the map.", 3800, crowned);
    feed({ crown: 1, sd: 1 });
}

function tenSeconds() {
    S.ten = true;
    for (const c of (hooks.clients ? hooks.clients() : [])) {
        const b = c && c.player && c.player.body;
        const mine = b && holderOf(b);
        try { c.talk('KC', 'crown10', "10 SECONDS", 0, mine ? "Hold on to that crown!" : "Take a crown now or it's over.", 2600); } catch { /* */ }
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
    if (!S.sd && left <= SUDDEN_MS) suddenDeath();
    if (!S.ten && left <= TEN_MS) tenSeconds();
    for (const h of S.holders) { h.body.crowned = true; h.body.crownLocked = S.sd; }
}

// Vault or base deposit: a message when it's refused, else null
function bankBlocked(body) {
    if (!enabled() || !S.on || !S.sd || S.done || !holderOf(body)) return null;
    return "Crowns can't bank in sudden death. Keep it to the bell!";
}

// The order a raid ends in: crown holders first by score, then everyone
// else by score. rows: anything; key(row) -> stat key, score(row) -> pts.
// Stable for ties (the caller's order stands).
function crownKeys() { return new Set(S.on ? S.holders.map(h => h.key).filter(Boolean) : []); }
function rank(rows, key, score) {
    const keys = crownKeys();
    if (!keys.size) return rows.slice();
    const idx = new Map(rows.map((r, i) => [r, i]));
    return rows.slice().sort((a, b) => {
        const ca = keys.has(key(a)) ? 1 : 0, cb = keys.has(key(b)) ? 1 : 0;
        if (ca !== cb) return cb - ca;
        return (score(b) - score(a)) || (idx.get(a) - idx.get(b));
    });
}
// holder rows by score, best first: [{key, body, id, name, score, bot}]
function standings() {
    return S.holders.map(h => ({ key: h.key, body: h.body, id: h.id, name: nameOf(h.body), score: scoreOf(h.body), bot: !h.body.socket }))
        .sort((a, b) => b.score - a.score);
}

// raid end: the crowns stop moving. -> standings at the bell
function finish() {
    if (!S.on) return [];
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
            e: r.id, n: r.name.slice(0, 16), s: r.score, b: r.bot ? 1 : 0, f: fz ? 1 : 0,
            x: fz ? Math.round(at.x / FUZZ) * FUZZ : Math.round(at.x), y: fz ? Math.round(at.y / FUZZ) * FUZZ : Math.round(at.y),
        });
    }
    return { on: 1, sd: S.sd ? 1 : 0, done: S.done ? 1 : 0, fz: FUZZ, list };
}

function newRaid() {
    for (const h of S.holders) if (h.body) { h.body.crowned = false; h.body.crownLocked = false; }
    const n = S.n;
    S = fresh();
    S.n = n;
    global.royaleCrownSD = false;
}

function active() { return enabled() && S.on && !S.done; }
function suddenOn() { return active() && S.sd; }

module.exports = {
    ON, SLOTS, STEAL_FRAC, BOT_KILL_SHARE, SUDDEN_MS, TEN_MS, MIN_LEFT_MS, FUZZ, MAX_HUNTERS, CHAMP_MS,
    attach, enabled, botKillShare, tick, onDeath, bankBlocked, rank, crownKeys, standings, finish, snapshot, newRaid,
    active, suddenOn, isCrowned, holderOf,
    _state: () => S,
};
