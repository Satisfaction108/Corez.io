// Ranked in the game thread: per-life accounting on the Dig Royale stat
// objects (raidStats values).
//
// A life's rank points are basisOf(s) at its end minus the snapshot taken at
// its start (s.lifeBase). basisOf is the board score without the carried
// half and without s.rankDiscount (half of every bot kill, all of an
// excluded kill); kill points are booked at kill time (s.killPts), so a
// twist that changes the kill score mid-raid does not re-price old kills.
// The carried half only counts when the raid ends under you.
//
// Rank-only points (s.rankOnly, raid-cumulative, never on the board): active
// survival (surviveCheck, every SURVIVE_STEP_MS) and damage dealt to real
// players (onPlayerDamaged). Rates and caps: REWARDS.survive / .damage in
// shared/ranks.js; the rules: ranked.survivalActive/survivalPts/damageGain.
//
// Life fields on the stat: lifeOpen, lifeId, lifeBase, lifeStartAt,
// lifeKills, lifeBotKills, lifeKillPts, lifeBanked0, lifeNoFare, lifeDust,
// lifeSurviveMs, lifeSurvivePts, lifeDmgPts, lifeDmg (victim key -> share of
// a bar dealt), survAt, survX/survY/survMovedAt, accountId, rankCode. A
// resume re-keys the stat (claimResume) and keeps the open life. raidAcct (per account, cleared when a raid starts) holds the
// raid-cumulative counted points for the diminishing-returns curve, who
// this account killed, and when it joined.
//
// Settled at: death (onDeath), raid end (onRaidEnd, before the mass death),
// a disconnect nobody resumed (RESUME_MS + 1 s later, with the fare), and a
// clean shutdown (no fare). A crash leaves the row open; the main thread
// closes it with delta 0 at the next boot.
//
// dig_royale.js calls attach() once with accessors for its state, and
// guards every call: nothing here may take the raid down.
'use strict';

const nodeCrypto = require('crypto');
const accounts = require('../index');
const rankStore = require('../rankStore');
const ranked = require('../ranked');
const dustHooks = require('./dustHooks');
const progress = require('./progressHooks');
const R = require('../../../shared/ranks.js');

const BOOT_ID = Date.now().toString(36) + nodeCrypto.randomBytes(3).toString('hex');

let bridgeMod = null;
function bridge() { return bridgeMod || (bridgeMod = require('./bridge')); }
function on() { return bridge().rankedOn(); }

// {stats() -> Map, clients() -> sockets, raidId() -> n, board() -> [{s, score}], resumeMs, serverId}
let ctx = null;
const raidAcct = new Map();        // accountId -> {counted, victims:Map, joinedAt}
const openByAcct = new Map();      // accountId -> stat with the open life
const ALIVE_CHECK_MS = 5000;
let aliveCheckAt = 0;
const SURVIVE_STEP_MS = 5000;
const SURVIVE_MOVE_MIN = 80;       // world units between checks that count as moving
let surviveCheckAt = 0;
let errAt = 0;

function logErr(what, e) {
    const t = Date.now();
    if (t - errAt < 10000) return;
    errAt = t;
    console.error('[accounts] ranked ' + what + ' failed: ' + ((e && e.stack) || e));
}

function raidKey() { return BOOT_ID + ':' + (ctx ? ctx.raidId() | 0 : 0); }

function attach(c) {
    ctx = c;
    dustHooks.setRef(raidKey);
    dustHooks.setCreditListener((userId, milli) => {
        const s = openByAcct.get(userId);
        if (s && s.lifeOpen) s.lifeDust = (s.lifeDust | 0) + (milli | 0);
    });
    accounts.onShutdown(onShutdown);
}

function basisOf(s) {
    return Math.floor(+s.banked || 0) + (s.killPts | 0) + (s.revengeBonus | 0) + (s.extra | 0) + (s.rankOnly | 0) - (s.rankDiscount || 0);
}

function acctFor(userId, t) {
    let a = raidAcct.get(userId);
    if (!a) { a = { counted: 0, victims: new Map(), joinedAt: t }; raidAcct.set(userId, a); }
    return a;
}

function codeOfSnap(snap) {
    if (!snap) return R.CODE_NONE;
    return snap.division == null ? R.rankCode(null, true) : R.rankCode(snap.division, false);
}

// ---- life start ----

// A human body entered the raid (spawn, respawn, resume, or a new raid
// starting around it). A resume keeps the life that is already open.
function lifeStart(body, s) {
    if (!body || !s || !body.socket) return;
    const t = Date.now();
    if (s.lifeOpen) {
        s.lifeDiscGen = (s.lifeDiscGen | 0) + 1;    // cancels a pending disconnect settle
        if (s.accountId) { s.rankCode = body.rankCode | 0; openByAcct.set(s.accountId, s); }
        return;
    }
    const account = on() && body.socket.account && body.socket.account.id ? body.socket.account : null;
    s.lifeOpen = true;
    s.lifeId = nodeCrypto.randomUUID();
    s.lifeBase = basisOf(s);
    s.lifeStartAt = t;
    s.lifeKills = 0;
    s.lifeBotKills = 0;
    s.lifeKillPts = 0;
    s.lifeBanked0 = +s.banked || 0;
    s.lifeNoFare = false;
    s.lifeDust = 0;
    s.lifeSurviveMs = 0;
    s.lifeSurvivePts = 0;
    s.lifeDmgPts = 0;
    s.lifeDmg = null;
    s.survAt = t;
    s.survMovedAt = 0;
    s.survX = body.x; s.survY = body.y;
    s.lifeRowOk = false;
    s.accountId = account ? account.id : 0;
    s.guestId = !body.socket.account && body.socket.guestId ? body.socket.guestId : null;
    s.rankCode = account ? body.rankCode | 0 : 0;
    if (!account) return;
    const a = acctFor(account.id, t);
    openByAcct.set(account.id, s);
    openRow(s, a);
}

function openRow(s, a) {
    try {
        const r = rankStore.openLife({
            lifeId: s.lifeId, userId: s.accountId, raidKey: raidKey(), serverId: ctx && ctx.serverId,
            startedAt: s.lifeStartAt, basisStart: s.lifeBase, raidPtsStart: a.counted,
        });
        s.lifeRowOk = !!r;
    } catch (e) { logErr('open', e); }
}

// ---- life end ----

function guestResult(basis) {
    const gain = ranked.lifeGain(0, basis);
    const division = R.divisionOf(gain);
    return { v: 1, guest: true, basis, wouldBe: gain > 0 && division > 0 ? { division, name: R.nameOf(division) } : null };
}

// Closes the stat's open life. opts.carried: gems still carried (raid end
// only; half of it counts). -> the RK payload (account or guest), or null
function lifeEnd(s, reason, opts = {}) {
    if (!s || !s.lifeOpen) return null;
    s.lifeOpen = false;
    const t = Date.now();
    const carriedHalf = opts.carried > 0 ? Math.floor(opts.carried / 2) : 0;
    const rawBasis = Math.max(0, Math.floor(basisOf(s) + carriedHalf - (s.lifeBase || 0)));
    // Duo lives count toward the same rank, at a reduced rate: a partner
    // carries part of the work (R.DUO_RP_MULT, shared/ranks.js). The point
    // sources below keep their raw sizes; they only split the gain.
    const basis = Config.royale_duos ? Math.floor(rawBasis * R.DUO_RP_MULT) : rawBasis;
    const userId = s.accountId | 0;
    if (openByAcct.get(userId) === s) openByAcct.delete(userId);
    if (!userId) {
        if (s.guestId && accounts.enabled()) {
            require('../guests').life(s.guestId, { score: basis, kills: s.lifeKills, botKills: s.lifeBotKills, ms: t - (s.lifeStartAt || t) }, t);
        }
        return on() ? guestResult(basis) : null;
    }
    const a = acctFor(userId, t);
    let balance = 0;
    try { balance = dustHooks.flushAccount(userId, t); } catch (e) { logErr('dust flush', e); }
    const banked = Math.max(0, Math.floor((+s.banked || 0) - (s.lifeBanked0 || 0)));
    const kills = Math.max(0, s.lifeKillPts | 0);
    const survived = Math.max(0, s.lifeSurvivePts | 0);
    const damage = Math.max(0, s.lifeDmgPts | 0);
    const bonus = Math.max(0, rawBasis - banked - kills - carriedHalf - survived - damage);
    let payload = null;
    try {
        if (!s.lifeRowOk) openRow(s, a);
        payload = rankStore.settleLife({
            lifeId: s.lifeId, userId, reason, now: t, basis, countedBefore: a.counted,
            durationMs: t - (s.lifeStartAt || t), noFare: !!s.lifeNoFare,
            kills: s.lifeKills | 0, botKills: s.lifeBotKills | 0,
            sources: [['Banked', banked], ['KOs', kills], ['Survived', survived], ['Damage', damage], ['Carried', carriedHalf], ['Bonus', bonus]],
            dust: { lifeMilli: s.lifeDust | 0, balanceMilli: balance },
        });
    } catch (e) { logErr('settle', e); }
    if (payload) {
        a.counted += basis;
        s.rankCode = codeOfSnap(payload.after);
        if (payload.rankUp) {
            try { accounts.bus.toMain({ t: 'rankUp', userId, division: payload.after.division, tierUp: !!payload.tierUp }); } catch (e) { /* */ }
        }
        try { progress.afterLife(bridge().socketOf(userId), userId, reason, t - (s.lifeStartAt || t)); } catch (e) { logErr('progress', e); }
    }
    return payload;
}

// A human died in the raid (onCombatantDead). Raid-end deaths were settled
// at endRaid already; their RK is waiting on the socket.
function onDeath(body, s) {
    if (!body || !body.socket || !s || !s.lifeOpen) return;
    const payload = lifeEnd(s, 'death');
    if (payload) body.socket._rkPending = payload;
}

// A kill was credited (onCombatantDead, after the points are known).
// pts: everything the kill paid the killer.
function onKillCredited(killer, ks, victim, vs, pts) {
    if (!ks || !victim) return;
    const t = Date.now();
    const victimIsBot = !victim.socket;
    const bornAt = (vs && vs.lifeOpen && vs.lifeStartAt) || victim.royaleBornAt || 0;
    const aliveMs = bornAt ? t - bornAt : Infinity;
    const killerId = killer && killer.socket && killer.socket.account && on() ? killer.socket.account.id : 0;
    let prior = 0;
    if (killerId && !victimIsBot) {
        const vkey = victim.socket.account ? 'a:' + victim.socket.account.id : 'g:' + ((vs && vs.key) || victim.id);
        const a = acctFor(killerId, t);
        prior = a.victims.get(vkey) | 0;
        a.victims.set(vkey, prior + 1);
    }
    const f = ranked.killFilter({ victimIsBot, victimAliveMs: aliveMs, priorKills: prior, pts });
    ks.rankDiscount = (ks.rankDiscount || 0) + f.discount;
    if (ks.lifeOpen) {
        ks.lifeKillPts = (ks.lifeKillPts | 0) + Math.max(0, pts - f.discount);
        if (victimIsBot) ks.lifeBotKills = (ks.lifeBotKills | 0) + 1;
        else ks.lifeKills = (ks.lifeKills | 0) + 1;
    }
    if (f.spawnKill && vs) vs.lifeNoFare = true;
    if (f.dustMilli && killerId) dustHooks.creditKill(killer.socket, f.dustMilli);
    if (killerId && !f.filtered) {
        try { progress.onKill(killer.socket, victimIsBot); } catch (e) { logErr('progress', e); }
    }
}

// Damage a real player took this tick (entity.contemplationOfMortality via
// dig_royale): `dealt` health+shield actually removed, `inflictors` the
// colliding things' masters. Split evenly between the human tanks behind
// it, like the boss assist share. Bots, self, teammates and the victim's
// own account earn nothing; the victim's share of a bar is capped per
// victim and per life (ranked.damageGain).
function onPlayerDamaged(victim, dealt, inflictors) {
    if (!ctx || !victim || !victim.socket || !(dealt > 0) || !inflictors || !inflictors.length) return;
    const max = ((victim.health && victim.health.max) || 0) + ((victim.shield && victim.shield.max) || 0);
    if (!(max > 0)) return;
    // distinct human roots, no allocation for the usual one or two
    let r0 = null, r1 = null, r2 = null, n = 0;
    for (let i = 0; i < inflictors.length; i++) {
        let root = inflictors[i], hops = 0;
        while (root && root.master && root.master !== root && hops++ < 8) root = root.master;
        if (!root || root === victim || !root.socket || root === r0 || root === r1 || root === r2) continue;
        if (n === 0) r0 = root; else if (n === 1) r1 = root; else if (n === 2) r2 = root; else break;
        n++;
    }
    if (!n) return;
    const share = Math.min(dealt, max) / max / n;
    const stats = ctx.stats();
    const vAcct = victim.socket.account && victim.socket.account.id;
    const vkey = vAcct ? 'a:' + vAcct : 's:' + victim.socket.id;
    for (let i = 0; i < n; i++) {
        const root = i === 0 ? r0 : i === 1 ? r1 : r2;
        if (root.team != null && root.team === victim.team) continue;
        if (vAcct && root.socket.account && root.socket.account.id === vAcct) continue;
        const s = stats.get('s:' + root.socket.id);
        if (!s || !s.lifeOpen) continue;
        if (!s.lifeDmg) s.lifeDmg = new Map();
        const g = ranked.damageGain(s.lifeDmg.get(vkey) || 0, share, s.lifeDmgPts | 0);
        s.lifeDmg.set(vkey, g.share);
        if (g.gain > 0) {
            s.lifeDmgPts = (s.lifeDmgPts | 0) + g.gain;
            s.rankOnly = (s.rankOnly | 0) + g.gain;
        }
    }
}

// Active survival, every SURVIVE_STEP_MS: each human with an open life
// that counts as active at this check is credited the time since the last
// one (at most two steps, so a stall or a resume gap pays nothing extra).
function surviveCheck(t) {
    if (!ctx || (ctx.live && !ctx.live())) return;
    const stats = ctx.stats();
    for (const c of ctx.clients()) {
        if (!c || !c.id) continue;
        const s = stats.get('s:' + c.id);
        if (!s || !s.lifeOpen) continue;
        const body = c.player && c.player.body;
        const dt = Math.min(2 * SURVIVE_STEP_MS, Math.max(0, t - (s.survAt || t)));
        s.survAt = t;
        if (!body || body.socket !== c) continue;
        const dx = body.x - (s.survX || 0), dy = body.y - (s.survY || 0);
        if (dx * dx + dy * dy >= SURVIVE_MOVE_MIN * SURVIVE_MOVE_MIN) s.survMovedAt = t;
        s.survX = body.x; s.survY = body.y;
        const lastActive = Math.max(c.lastInputAt || 0, s.survMovedAt || 0);
        const active = ranked.survivalActive({
            dead: !!(body.isDead && body.isDead()), invuln: !!body.invuln || !!body.godmode,
            safe: !!body.padSafe || !!body.passive || !!body.royaleLobby, frozen: !!body.royaleFrozen,
            graceLeftMs: (body.spawnGraceUntil || 0) - t, sinceActiveMs: lastActive ? t - lastActive : -1,
        });
        if (!active || !dt) continue;
        s.lifeSurviveMs = (s.lifeSurviveMs || 0) + dt;
        const pts = ranked.survivalPts(s.lifeSurviveMs);
        const inc = pts - (s.lifeSurvivePts | 0);
        if (inc > 0) {
            s.lifeSurvivePts = pts;
            s.rankOnly = (s.rankOnly | 0) + inc;
        }
    }
}

// A socket left mid-life. If nobody resumes it within the resume window,
// the life settles as a disconnect (with the fare).
function onDisconnect(socket, s) {
    if (!s || !s.lifeOpen) return;
    const gen = s.lifeDiscGen = (s.lifeDiscGen | 0) + 1;
    const lifeId = s.lifeId;
    const wait = ((ctx && ctx.resumeMs) || 120000) + 1000;
    const timer = setTimeout(() => {
        try {
            if (!s.lifeOpen || s.lifeId !== lifeId || s.lifeDiscGen !== gen) return;
            const clients = ctx ? ctx.clients() : [];
            if (clients.some(c => c && ('s:' + c.id) === s.key)) return;    // resumed, not yet spawned
            lifeEnd(s, 'disconnect');
        } catch (e) { logErr('disconnect', e); }
    }, wait);
    if (timer.unref) timer.unref();
}

// ---- raid ----

function onRaidStart() {
    raidAcct.clear();
    openByAcct.clear();
}

// endRaid, before the mass death: settle every open life (the carried half
// counts), then the placement bonus. RK waits on the socket for the death
// packet; RKP goes out now.
function onRaidEnd() {
    if (!ctx) return;
    const t = Date.now();
    const stats = ctx.stats();
    const byKey = new Map(), byAcct = new Map();
    for (const c of ctx.clients()) {
        if (!c || !c.id) continue;
        byKey.set('s:' + c.id, c);
        if (c.account && c.account.id) byAcct.set(c.account.id, c);
    }
    for (const s of stats.values()) {
        if (!s.lifeOpen) continue;
        try {
            const payload = lifeEnd(s, 'raidend', { carried: s.alive ? s.carried | 0 : 0 });
            const client = byKey.get(s.key);
            if (payload && client) client._rkPending = payload;
        } catch (e) { logErr('raid end', e); }
    }
    if (on()) {
        const key = raidKey();
        const order = ctx.board();
        // duos: entries carry their team's place and the number of teams
        const rows = order.length && order[0].rows ? order[0].rows : order.length;
        const top = [];
        order.forEach((e, i) => {
            const s = e.s;
            if (!s || !s.accountId) return;
            try {
                const a = raidAcct.get(s.accountId);
                const res = rankStore.applyRaidPlacement({
                    raidKey: key, userId: s.accountId, place: e.place || i + 1, rows, score: e.teamScore != null ? e.teamScore : e.score,
                    raidMs: a ? t - a.joinedAt : 0, now: t,
                });
                if (!res) return;
                dustHooks.noteExternalCredit(s.accountId, res.bonusDustMilli, res.balanceMilli);
                s.rankCode = codeOfSnap(res.after);
                // an account that came back without a resume has an older row
                // too: the best one is paid, and the result goes to whichever
                // socket the account plays on now
                if (res.eligible && res.place <= 3) top.push({ userId: s.accountId, place: res.place, score: res.score });
                const client = byAcct.get(s.accountId);
                try { progress.afterPlacement(client || null, s.accountId, res); } catch (e2) { logErr('progress', e2); }
                if (!client) return;
                if (res.bonusDustMilli) bridge().du(client, res.bonusDustMilli, 5, true);
                if (res.place <= 10) {
                    const { balanceMilli, eligible, ...rkp } = res;
                    client.talk('RKP', JSON.stringify(rkp));
                }
                if (res.rankUp) {
                    try { accounts.bus.toMain({ t: 'rankUp', userId: s.accountId, division: res.after.division, tierUp: !!res.tierUp }); } catch (e2) { /* */ }
                }
            } catch (err) { logErr('placement', err); }
        });
        // Discord announcement of the raid's top-3 account holders (main thread)
        if (top.length) {
            try { accounts.bus.toMain({ t: 'raidTop', raidKey: key, top }); } catch (e) { /* */ }
        }
    }
    try { dustHooks.flushAll(t); } catch (e) { logErr('dust flush', e); }
}

// accounts.shutdown (SIGINT/SIGTERM): settle what is open, no fare.
function onShutdown() {
    if (!ctx) return;
    const stats = ctx.stats();
    for (const s of stats.values()) {
        if (!s.lifeOpen || !s.accountId) continue;
        try { lifeEnd(s, 'shutdown'); } catch (e) { logErr('shutdown', e); }
    }
    try { dustHooks.flushAll(); } catch (e) { logErr('dust flush', e); }
    try { progress.saveAll(); } catch (e) { logErr('progress', e); }
}

// Living account bodies: the survive quest, Survivor, Hoarder.
function checkAlive(t) {
    if (!ctx || !openByAcct.size || !on()) return;
    const bySid = new Map();
    for (const c of ctx.clients()) if (c && c.id && c.account) bySid.set('s:' + c.id, c);
    for (const s of openByAcct.values()) {
        if (!s.lifeOpen || !s.lifeStartAt) continue;
        const c = bySid.get(s.key);
        const body = c && c.player && c.player.body;
        if (!body || body.socket !== c || (body.isDead && body.isDead())) continue;
        progress.onAlive(body, t - s.lifeStartAt);
    }
}

function tick(t) {
    dustHooks.tick(t);
    try { progress.tick(t); } catch (e) { logErr('progress', e); }
    if (t - surviveCheckAt >= SURVIVE_STEP_MS) {
        surviveCheckAt = t;
        try { surviveCheck(t); } catch (e) { logErr('survive', e); }
    }
    if (t - aliveCheckAt >= ALIVE_CHECK_MS) {
        aliveCheckAt = t;
        try { checkAlive(t); } catch (e) { logErr('alive', e); }
    }
}

// DBG rank <rp> (debug mode only; the caller checks).
function debugRank(socket, rp) {
    if (!socket || !socket.account || !bridge().debugOn()) return false;
    const row = rankStore.debugSetRp(socket.account.id, rp);
    if (!row) return false;
    const code = rankStore.codeOf(row);
    const body = socket.player && socket.player.body;
    if (body) body.rankCode = code;
    const s = ctx ? ctx.stats().get('s:' + socket.id) : null;
    if (s) s.rankCode = code;
    bridge().sendAccount(socket, row, body);
    return true;
}

// DBG rankpts (ROYALE_DEBUG only; the caller checks): the rank-only counters.
function debugPts(socket) {
    const s = ctx && socket ? ctx.stats().get('s:' + socket.id) : null;
    if (!s) return null;
    return {
        open: !!s.lifeOpen, surviveMs: s.lifeSurviveMs | 0, survivePts: s.lifeSurvivePts | 0,
        dmgPts: s.lifeDmgPts | 0, rankOnly: s.rankOnly | 0, lifeBasis: basisOf(s) - (s.lifeBase || 0),
        sinceInputMs: socket.lastInputAt ? Date.now() - socket.lastInputAt : -1,
        safe: !!(socket.player && socket.player.body && (socket.player.body.padSafe || socket.player.body.passive)),
    };
}

module.exports = {
    BOOT_ID, attach, basisOf, raidKey, lifeStart, lifeEnd, onDeath, onKillCredited, onDisconnect,
    onPlayerDamaged, surviveCheck, onRaidStart, onRaidEnd, onShutdown, tick, debugRank, debugPts, on,
    _raidAcct: raidAcct,
};
