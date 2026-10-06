// Ranked in the game thread: per-life accounting on the Dig Royale stat
// objects (raidStats values).
//
// A life's rank points = basisOf(s) at its end - s.lifeBase (taken at its
// start)
// points are booked at kill time (s.killPts), so a twist that changes kill
// scoring mid-raid does not re-price old kills. The carried half counts only
// when the raid ends under you.
//
// Rank-only points (s.rankOnly, raid-cumulative, never on the board): active
// survival (surviveCheck, every SURVIVE_STEP_MS) and damage dealt to real
// players (onPlayerDamaged). Rates and caps: REWARDS.survive / .damage in
// shared/ranks.js; the rules: ranked.survivalActive/survivalPts/damageGain.
//
// Idle time earns nothing. "Active" is real input (game/network/activity.js)
// within REWARDS.survive.activeWindowMs; a tank that only drifts (recoil,
// being shoved) is not active. A kill or damage by a player with no input
// for activity.IDLE_PROTECT_MS pays nothing, and the raid placement bonus
// needs ranked.activeEnough over the raid (input time vs time alive).
//
// A restored save (saveCodes.js) adds its points to s.rankDiscount, and so
// does every gem of its satchel banked later (dig_royale onBanked); the
// satchel still carried at a raid end is left out of the carried half. So a
// restored life only ranks on what it earned after the restore.
//
// Life fields on the stat: lifeOpen, lifeId, lifeBase, lifeStartAt,
// lifeKills, lifeBotKills, lifeKillPts, lifeBanked0, lifeNoFare, lifeDust,
// lifeSurviveMs, lifeSurvivePts, lifeInputMs (alive with fresh input, safe
// pads and shields included), lifeDmgPts, lifeDmg (victim key -> share of
// a bar dealt), survAt, accountId, rankCode. A resume re-keys the stat
// (claimResume) and keeps the open life.
// raidAcct (per account, cleared at raid start): raid-cumulative counted
// points for the diminishing-returns curve, victims, join time, for the win
// streak the counted lives settled and the active survival time, and for
// the placement rule the input and alive time of settled lives and whether
// the account was kicked for idling this raid.
//
// Settled at: death (onDeath), raid end (onRaidEnd, before the mass death),
// a disconnect nobody resumed (RESUME_MS + 1 s later, with the fare), an idle
// kick (onIdleKick: no gain, the fare, no placement for the raid), and a
// clean shutdown (no fare). A crash leaves the row open; the main thread
// closes it with delta 0 at the next boot.
//
// dig_royale.js calls attach() once with state accessors and guards every
// call: nothing here may take the raid down.
'use strict';

const nodeCrypto = require('crypto');
const accounts = require('../index');
const rankStore = require('../rankStore');
const ranked = require('../ranked');
const streaks = require('../streaks');
const dustHooks = require('./dustHooks');
const progress = require('./progressHooks');
const activity = require('../../game/network/activity.js');
const R = require('../../../shared/ranks.js');

const BOOT_ID = Date.now().toString(36) + nodeCrypto.randomBytes(3).toString('hex');

let bridgeMod = null;
function bridge() { return bridgeMod || (bridgeMod = require('./bridge')); }
function on() { return bridge().rankedOn(); }

// {stats() -> Map, clients() -> sockets, raidId() -> n, board() -> [{s, score}], resumeMs, serverId}
let ctx = null;
const raidAcct = new Map();        // accountId -> {counted, victims:Map, joinedAt, lives, activeMs, inputMs, aliveMs, idleKicked}
const openByAcct = new Map();      // accountId -> stat with the open life
const ALIVE_CHECK_MS = 5000;
let aliveCheckAt = 0;
const SURVIVE_STEP_MS = 5000;
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
    if (!a) { a = { counted: 0, victims: new Map(), joinedAt: t, lives: 0, activeMs: 0, inputMs: 0, aliveMs: 0, idleKicked: false }; raidAcct.set(userId, a); }
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
    s.lifeInputMs = 0;
    s.lifeDmgPts = 0;
    s.lifeDmg = null;
    s.survAt = t;
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
// only; half of it counts). An 'idle' end (the idle kick) counts nothing.
// -> the RK payload (account or guest), or null
function lifeEnd(s, reason, opts = {}) {
    if (!s || !s.lifeOpen) return null;
    s.lifeOpen = false;
    const t = Date.now();
    const idle = reason === 'idle';
    const carriedHalf = !idle && opts.carried > 0 ? Math.floor(opts.carried / 2) : 0;
    const rawBasis = idle ? 0 : Math.max(0, Math.floor(basisOf(s) + carriedHalf - (s.lifeBase || 0)));
    // Duo lives count toward the same rank at R.DUO_RP_MULT (a partner carries
    // part of the work). The point sources below keep raw sizes; they only
    // split the gain.
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
    const durationMs = t - (s.lifeStartAt || t);
    const inputMs = Math.max(0, s.lifeInputMs || 0);
    // the time alive and the part of it with fresh input, for the raid's
    // placement rule (settled lives only: a raid end settles every open one
    // before the placement is paid)
    a.aliveMs += Math.max(0, durationMs);
    a.inputMs += inputMs;
    let payload = null;
    try {
        if (!s.lifeRowOk) openRow(s, a);
        payload = rankStore.settleLife({
            lifeId: s.lifeId, userId, reason, now: t, basis, countedBefore: a.counted,
            durationMs, activeMs: inputMs, noFare: !!s.lifeNoFare,
            kills: s.lifeKills | 0, botKills: s.lifeBotKills | 0,
            sources: idle ? [] : [['Banked', banked], ['KOs', kills], ['Survived', survived], ['Damage', damage], ['Carried', carriedHalf], ['Bonus', bonus]],
            dust: { lifeMilli: s.lifeDust | 0, balanceMilli: balance },
        });
    } catch (e) { logErr('settle', e); }
    if (payload) {
        a.counted += basis;
        a.activeMs += Math.max(0, s.lifeSurviveMs || 0);
        if (!idle && ranked.countsForPlacement(inputMs, payload.basis)) a.lives++;
        s.rankCode = codeOfSnap(payload.after);
        if (payload.streak) noteStreak(userId, payload.streak, clientOf(s) || bridge().socketOf(userId));
        if (payload.rankUp) {
            try { accounts.bus.toMain({ t: 'rankUp', userId, division: payload.after.division, tierUp: !!payload.tierUp }); } catch (e) { /* */ }
        }
        try { progress.afterLife(bridge().socketOf(userId), userId, reason, inputMs); } catch (e) { logErr('progress', e); }
        // invites wait for the new account's first finished life
        try { accounts.bus.toMain({ t: 'lifeSettled', userId }); } catch (e) { /* */ }
    }
    return payload;
}

// A streak moved (life settled, raid placement): the HUD balance, the
// dust pop, the in-raid card (STK) and the menu (SSE 'streak'). A win
// streak reset only goes to the menu.
function noteStreak(userId, st, client) {
    if (!st) return;
    if (st.rewardMilli) dustHooks.noteExternalCredit(userId, st.rewardMilli, st.balanceMilli);
    const data = {
        kind: st.kind, streak: st.streak | 0, best: st.best | 0, rewardMilli: st.rewardMilli | 0, reset: !!st.reset,
        nextMilli: st.kind === 'play' ? streaks.playReward(st.streak + 1) : streaks.winReward(st.streak + 1),
    };
    if (client) {
        if (st.rewardMilli) bridge().du(client, st.rewardMilli, 8, true);
        if (!st.reset) { try { client.talk('STK', JSON.stringify(data)); } catch (e) { /* closing */ } }
    }
    try { accounts.bus.toMain({ t: 'streak', userId, ...data }); } catch (e) { /* */ }
}

// The live socket of a stat, if it is still here.
function clientOf(s) {
    if (!ctx || !s || !s.key) return null;
    for (const c of ctx.clients()) if (c && c.id && ('s:' + c.id) === s.key && !c.terminated) return c;
    return null;
}

// A human died in the raid (onCombatantDead). Raid-end deaths are settled
// in onRaidEnd; their RK is already waiting on the socket.
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
    // an AFK tank's autofire or turrets never earn: the kill pays nothing
    const killerIdle = !!(killer && killer.socket && activity.inputIdleMs(killer.socket, t) > activity.IDLE_PROTECT_MS);
    const f = ranked.killFilter({ victimIsBot, victimAliveMs: aliveMs, priorKills: prior, pts, killerIdle });
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
// dig_royale): `dealt` = health+shield removed, `inflictors` = colliders.
// Split evenly between the human tanks behind it, like the boss assist
// share. Bots, self, teammates and the victim's own account earn nothing;
// the share is capped per victim and per life (ranked.damageGain).
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
        if (activity.inputIdleMs(root.socket) > activity.IDLE_PROTECT_MS) continue;
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
// Only real input makes a check active; a body that moved without any
// (recoil from autofire, shoved by a bot) is still idle.
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
        const dead = !!(body.isDead && body.isDead());
        const sinceInput = c.lastInputAt ? t - c.lastInputAt : -1;
        if (!dead && dt && sinceInput >= 0 && sinceInput <= R.REWARDS.survive.activeWindowMs) s.lifeInputMs = (s.lifeInputMs || 0) + dt;
        const active = ranked.survivalActive({
            dead, invuln: !!body.invuln || !!body.godmode,
            safe: !!body.padSafe || !!body.passive || !!body.royaleLobby, frozen: !!body.royaleFrozen,
            graceLeftMs: (body.spawnGraceUntil || 0) - t, sinceActiveMs: sinceInput,
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
// immediate: they left on purpose (menu, another tab), so no resume is coming
const VOID_LEAVE_MS = 60 * 1000;
function voidLife(s) {
    s.lifeOpen = false;
    const userId = s.accountId | 0;
    if (openByAcct.get(userId) === s) openByAcct.delete(userId);
    if (!userId || !s.lifeId) return;
    const d = accounts.db.handle();
    if (d) d.run('DELETE FROM rank_lives WHERE life_id = ? AND ended_at IS NULL', s.lifeId);
}

function onDisconnect(socket, s, immediate = false) {
    if (!s || !s.lifeOpen) return;
    if (immediate) {
        // Leaving on purpose in the first minute with nothing scored (e.g. the
        // coach's "Play the tutorial") voids the life instead of spending a
        // placement game or a fare on it.
        if (Date.now() - (s.lifeStartAt || 0) < VOID_LEAVE_MS && basisOf(s) - (s.lifeBase || 0) <= 0) {
            try { voidLife(s); } catch (e) { logErr('void', e); }
            return;
        }
        try { lifeEnd(s, 'disconnect'); } catch (e) { logErr('disconnect', e); }
        return;
    }
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

// The idle kick (dig_royale.idleKick, before the socket goes): the life
// ends with no gain (the fare still applies, like any other end that is not
// a raid end), and the raid pays this account no placement or win streak.
function onIdleKick(socket, s) {
    const userId = (s && s.accountId) || (socket && socket.account && socket.account.id) || 0;
    if (userId && on()) acctFor(userId, Date.now()).idleKicked = true;
    if (!s || !s.lifeOpen) return null;
    return lifeEnd(s, 'idle');
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
            // a restored save's satchel never counts (game/terrain/saveCodes.js)
            const carried = s.alive ? Math.max(0, (s.carried | 0) - (s.restoredCarry | 0)) : 0;
            const payload = lifeEnd(s, 'raidend', { carried });
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
        // the Crown Contest decided the raid: its champion (s.champWin) is
        // the win, whatever the placement rule says
        const contest = order.some(e => e.s && e.s.champWin);
        let champ = null;
        order.forEach((e, i) => {
            const s = e.s;
            if (!s || !s.accountId) return;
            try {
                const a = raidAcct.get(s.accountId);
                const raidMs = a ? t - a.joinedAt : 0;
                // placement pays only for a raid really played: enough of the
                // time alive with fresh input, and never after an idle kick
                const active = !!a && ranked.activeEnough(a);
                // the win streak only moves for a raid really played: in it
                // long enough for the bonus, a counted life, a minute active
                const played = active && a.lives > 0 && a.activeMs >= streaks.WIN_ACTIVE_MS && raidMs >= ranked.BONUS_MIN_RAID_MS;
                const res = rankStore.applyRaidPlacement({
                    raidKey: key, userId: s.accountId, place: e.place || i + 1, rows, score: e.teamScore != null ? e.teamScore : e.score,
                    raidMs, now: t, played, active, contest, champ: !!s.champWin,
                });
                if (!res) return;
                if (s.champWin) champ = { userId: s.accountId, score: res.score };
                dustHooks.noteExternalCredit(s.accountId, res.bonusDustMilli, res.balanceMilli);
                s.rankCode = codeOfSnap(res.after);
                // an account that rejoined without a resume has an older row
                // too: the best one is paid, and the result goes to its
                // current socket
                if (res.eligible && res.place <= 3) top.push({ userId: s.accountId, place: res.place, score: res.score });
                const client = byAcct.get(s.accountId);
                try { progress.afterPlacement(client || null, s.accountId, res); } catch (e2) { logErr('progress', e2); }
                if (client && res.bonusDustMilli) bridge().du(client, res.bonusDustMilli, 5, true);
                noteStreak(s.accountId, res.streak, client);
                if (!client) return;
                if (res.place <= 10) {
                    const { balanceMilli, eligible, streak, champ: _champ, ...rkp } = res;
                    client.talk('RKP', JSON.stringify(rkp));
                }
                if (res.rankUp) {
                    try { accounts.bus.toMain({ t: 'rankUp', userId: s.accountId, division: res.after.division, tierUp: !!res.tierUp }); } catch (e2) { /* */ }
                }
            } catch (err) { logErr('placement', err); }
        });
        // Discord announcement of the raid's top-3 account holders (main thread)
        if (top.length || champ) {
            try { accounts.bus.toMain({ t: 'raidTop', raidKey: key, raidNo: ctx.raidId() | 0, top, champ }); } catch (e) { /* */ }
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

// Living account bodies: the survive quest, Survivor (both on time alive
// with fresh input, not the wall clock), Hoarder.
function checkAlive(t) {
    if (!ctx || !openByAcct.size || !on()) return;
    const bySid = new Map();
    for (const c of ctx.clients()) if (c && c.id && c.account) bySid.set('s:' + c.id, c);
    for (const s of openByAcct.values()) {
        if (!s.lifeOpen || !s.lifeStartAt) continue;
        const c = bySid.get(s.key);
        const body = c && c.player && c.player.body;
        if (!body || body.socket !== c || (body.isDead && body.isDead())) continue;
        progress.onAlive(body, s.lifeInputMs || 0);
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
        open: !!s.lifeOpen, surviveMs: s.lifeSurviveMs | 0, survivePts: s.lifeSurvivePts | 0, inputMs: s.lifeInputMs | 0,
        idleMs: socket ? activity.idleMs(socket) : 0, inputIdleMs: socket ? activity.inputIdleMs(socket) : 0,
        invuln: !!(socket.player && socket.player.body && socket.player.body.invuln),
        dmgPts: s.lifeDmgPts | 0, rankOnly: s.rankOnly | 0, lifeBasis: basisOf(s) - (s.lifeBase || 0),
        sinceInputMs: socket.lastInputAt ? Date.now() - socket.lastInputAt : -1,
        safe: !!(socket.player && socket.player.body && (socket.player.body.padSafe || socket.player.body.passive)),
        raid: (() => {
            const a = s.accountId ? raidAcct.get(s.accountId) : null;
            return a ? { inputMs: a.inputMs | 0, aliveMs: a.aliveMs | 0, idleKicked: !!a.idleKicked, active: ranked.activeEnough(a) } : null;
        })(),
    };
}

module.exports = {
    BOOT_ID, attach, basisOf, raidKey, lifeStart, lifeEnd, onDeath, onKillCredited, onDisconnect, onIdleKick,
    onPlayerDamaged, surviveCheck, onRaidStart, onRaidEnd, onShutdown, tick, debugRank, debugPts, on,
    _raidAcct: raidAcct,
};
