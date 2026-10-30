'use strict';

const fs = require('fs');
const path = require('path');
const L = require('./teamLayout.js');

const { BLUE, RED, TEAMS } = L;
const TEAM_SIZE = (() => { const n = parseInt(process.env.ROYALE_TEAM_SIZE, 10); return Number.isFinite(n) && n >= 2 ? n : 6; })();
const KILL_PTS = 100;
const BOT_KILL_PTS = 60;
const BATTLE_PTS = 1500;
const WAR_PER_PLAYER = 4800;
const WAR_MIN = 18000;
const WAR_MAX = 48000;
const CALLS = {
    radar: { cost: 1, name: 'Radar Sweep' },
    supply: { cost: 1, name: 'Supply Drop' },
    titan: { cost: 1, name: 'Titan' },
};
const POLL_KINDS = ['radar', 'supply', 'titan'];
const POLL_MS = 30_000;
const POLL_RETRY_MS = 5_000;
const BOT_VOTE_MIN_MS = 2_000;
const BOT_VOTE_MAX_MS = 14_000;
const SMALL_CD_MS = 90_000;
const TITAN_CHANNEL_MS = 3000;
const BOT_CALL_AFTER_MS = 30_000;
const AUTO_CALL_AFTER_MS = 60_000;
const RADAR_MS = 15_000;
const VISION_R = 1150;
const TAIL_R = 300;
const TAIL_CAPTURE_MS = 7000;
const TAIL_SPAWN_SHARE = 0.35;
const HELP_HIT_MS = 3000;
const HELP_RANGE = 2300;
const HELPERS_PER_HUMAN = 2;
const DEFEND_SHARE = 0.5;
const ESCORT_PER_TITAN = 2;
const SAVE_EVERY_MS = 30_000;
const FILE = path.join(process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, '../../../data'), 'teamScore.json');

let hooks = {};
let active = false;
const st = fresh();

function fresh() {
    return {
        score: { [BLUE]: 0, [RED]: 0 },
        war: { [BLUE]: 0, [RED]: 0 },
        fullAt: { [BLUE]: 0, [RED]: 0 },
        warFull: { [BLUE]: false, [RED]: false },
        smallCdUntil: { [BLUE]: 0, [RED]: 0 },
        radarUntil: { [BLUE]: 0, [RED]: 0 },
        day: dayKey(),
        lastWinner: 0,
        tail: new Map(),
        orders: new Map(),
        jobs: new Map(),
        poll: { [BLUE]: null, [RED]: null },
        pollRetryAt: { [BLUE]: 0, [RED]: 0 },
        protectors: [],
        savedAt: 0,
        tickAt: 0,
        orderAt: 0,
    };
}

function dayKey(t = Date.now()) { return new Date(t).toISOString().slice(0, 10); }
function on() { return !!(typeof Config !== 'undefined' && Config.royale_teams && Config.dig_royale && !Config.tutorial); }
function attach(h) { hooks = Object.assign({}, hooks, h || {}); }
function hook(name, ...a) { try { return hooks[name] ? hooks[name](...a) : undefined; } catch (e) { console.error('[TEAMS] hook ' + name, e && e.stack || e); return undefined; } }
function titan() { return require('./titan.js'); }
function vault() { return require('./vault.js'); }
const alive = b => !!b && !b.isGhost && !(b.isDead && b.isDead());
const rootOf = e => { let r = e, n = 0; while (r && r.master && r.master !== r && n++ < 8) r = r.master; return r; };
const isFighter = b => alive(b) && (b.isPlayer || b.isBot) && L.isTeam(b.team);

function fighters() { return (hook('fighters') || []).filter(isFighter); }
function teamOf(body) { return body && L.isTeam(body.team) ? body.team : 0; }
function colorOf(team) { return team === BLUE ? 'blue' : team === RED ? 'red' : 'grey'; }

function countTeams() {
    const humans = { [BLUE]: 0, [RED]: 0 }, all = { [BLUE]: 0, [RED]: 0 };
    for (const b of fighters()) { all[b.team]++; if (b.socket && !b.isBot) humans[b.team]++; }
    for (const c of (hook('clients') || [])) {
        const b = c && c.player && c.player.body;
        if (c && c._tmTeam && !(b && alive(b))) humans[c._tmTeam] = (humans[c._tmTeam] || 0) + 1;
    }
    return { humans, all };
}

function pickSmaller(a, b) {
    if (a[BLUE] !== a[RED]) return a[BLUE] < a[RED] ? BLUE : RED;
    if (b && b[BLUE] !== b[RED]) return b[BLUE] < b[RED] ? BLUE : RED;
    if (st.score[BLUE] !== st.score[RED]) return st.score[BLUE] < st.score[RED] ? BLUE : RED;
    return Math.random() < 0.5 ? BLUE : RED;
}

const INVITE_MS = 15 * 60_000;
const INVITE_MAX_LEAD = 2;
const invites = new Map();

function inviteCode(socket, t = Date.now()) {
    if (!active || !socket) return null;
    const body = socket.player && socket.player.body;
    const team = body && L.isTeam(body.team) ? body.team : socket._tmTeam;
    if (!L.isTeam(team)) return null;
    for (const [k, v] of invites) if (v.until < t) invites.delete(k);
    if (socket._tmInvite && invites.has(socket._tmInvite) && invites.get(socket._tmInvite).team === team) {
        invites.get(socket._tmInvite).until = t + INVITE_MS;
        return socket._tmInvite;
    }
    let code = '';
    const abc = 'abcdefghjkmnpqrstuvwxyz23456789';
    for (let tries = 0; tries < 20; tries++) {
        code = '';
        for (let i = 0; i < 6; i++) code += abc[(Math.random() * abc.length) | 0];
        if (!invites.has(code)) break;
    }
    invites.set(code, { team, by: String((body && body.name) || 'A friend').slice(0, 24), until: t + INVITE_MS });
    socket._tmInvite = code;
    return code;
}

function joinCode(socket, code, t = Date.now()) {
    if (!active || !socket) return { ok: false, why: 'off' };
    const inv = invites.get(String(code || '').toLowerCase());
    if (!inv || inv.until < t) return { ok: false, why: "That team invite ran out. You'll join the team with fewer players." };
    const c = countTeams();
    if (c.humans[inv.team] - c.humans[L.other(inv.team)] >= INVITE_MAX_LEAD) return { ok: false, why: "The " + L.teamName(inv.team) + " team is full right now, so you'll join the other team." };
    socket._tmTeam = inv.team;
    rememberTeam(socket, inv.team, t);
    return { ok: true, team: inv.team, by: inv.by };
}

const REMEMBER_MS = 3 * 24 * 3600_000;
const REMEMBER_MAX_LEAD = 3;
const REMEMBER_CAP = 5000;
const remembered = new Map();

function whoKey(socket) {
    if (!socket) return null;
    if (socket.account && socket.account.id) return 'a:' + socket.account.id;
    if (typeof socket.guestId === 'string' && socket.guestId) return 'g:' + socket.guestId;
    return null;
}

function rememberTeam(socket, team, t = Date.now()) {
    const k = whoKey(socket);
    if (!k || !L.isTeam(team)) return;
    remembered.delete(k);
    remembered.set(k, { team, at: t });
    while (remembered.size > REMEMBER_CAP) remembered.delete(remembered.keys().next().value);
}

function rememberedTeam(socket, t = Date.now()) {
    const k = whoKey(socket);
    const r = k ? remembered.get(k) : null;
    if (!r) return 0;
    if (t - r.at > REMEMBER_MS || !L.isTeam(r.team)) { remembered.delete(k); return 0; }
    return r.team;
}

function teamForHuman(socket, kept, t = Date.now()) {
    let team = 0;
    if (socket && L.isTeam(socket._tmTeam)) team = socket._tmTeam;
    else if (kept && L.isTeam(kept.team)) team = kept.team;
    else {
        const c = countTeams();
        const prev = rememberedTeam(socket, t);
        if (L.isTeam(prev) && c.humans[prev] - c.humans[L.other(prev)] < REMEMBER_MAX_LEAD) team = prev;
        else team = pickSmaller(c.humans, c.all);
    }
    if (socket) socket._tmTeam = team;
    rememberTeam(socket, team, t);
    return team;
}

function teamForBot(prefer) {
    const c = countTeams();
    if (L.isTeam(prefer) && c.all[prefer] < TEAM_SIZE && c.all[prefer] <= c.all[L.other(prefer)]) return prefer;
    return pickSmaller(c.all, c.humans);
}

function botCap(humansNow) {
    return Math.max(0, TEAM_SIZE * 2 - (humansNow | 0));
}

function applyColor(body) {
    if (!body || !L.isTeam(body.team)) return;
    const c = colorOf(body.team);
    try { body.color.base = c; } catch { /* */ }
    body.leaderboardColor = c;
    body.minimapColor = c;
}

function holdColors() {
    if (!global.royaleTeamColors) global.royaleTeamColors = new Map();
    if (!global.royaleHeldTeamColors) global.royaleHeldTeamColors = new Map();
    for (const t of TEAMS) { global.royaleTeamColors.set(t, colorOf(t)); global.royaleHeldTeamColors.set(t, colorOf(t)); }
}

function baseTiles() {
    const room = global.gameManager && global.gameManager.room;
    const out = [];
    if (!room || !room.setup) return out;
    for (const row of room.setup) for (const tile of row) if (tile && tile.name && /^Royale Base/.test(tile.name)) out.push(tile);
    return out;
}

function paintTiles(teamsOn) {
    const room = global.gameManager && global.gameManager.room;
    for (const tile of baseTiles()) {
        const t = tile.data && tile.data.team;
        tile.color = teamsOn ? (t === BLUE ? 'blue' : 'red') : 'white';
    }
    if (room) room.sendColorsToClient = true;
}

function spawnProtector(loc, team) {
    if (!active) return;
    try {
        const o = new Entity(loc);
        o.define('royaleBaseProtector');
        o.team = team;
        o.color.base = getTeamColor(team);
        o.isRoyaleProtector = true;
        o.on('dead', () => { st.protectors = st.protectors.filter(p => p !== o); if (active) setTimeout(() => spawnProtector(loc, team), 1500); });
        st.protectors.push(o);
    } catch (e) { console.error('[TEAMS] protector', e && e.stack || e); }
}

function activate() {
    if (!on()) return false;
    if (active) return true;
    active = true;
    holdColors();
    paintTiles(true);
    for (const t of TEAMS) for (const p of L.protectorSpots(t)) spawnProtector({ x: p.x, y: p.y }, t);
    loadScore();
    for (const v of tailVaults()) st.tail.set(v, { owner: v.homeTeam || v.team, prog: 0, by: 0 });
    return true;
}

function deactivate() {
    if (!active) return;
    active = false;
    paintTiles(false);
    for (const p of st.protectors.slice()) { try { p.kill(); } catch { /* */ } }
    st.protectors = [];
    try { titan().clearAll(); } catch { /* */ }
    if (global.royaleHeldTeamColors) for (const t of TEAMS) global.royaleHeldTeamColors.delete(t);
    if (global.royaleTeamColors) for (const t of TEAMS) global.royaleTeamColors.delete(t);
    saveScore(true);
}

function loadScore() {
    try {
        const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
        if (j && j.day === dayKey()) { st.score[BLUE] = j.blue | 0; st.score[RED] = j.red | 0; st.day = j.day; }
        if (j && j.lastWinner) st.lastWinner = j.lastWinner;
        const t = Date.now();
        if (j && j.picks && typeof j.picks === 'object') {
            for (const [k, v] of Object.entries(j.picks)) {
                if (Array.isArray(v) && L.isTeam(v[0]) && t - (+v[1] || 0) <= REMEMBER_MS && !remembered.has(k)) remembered.set(k, { team: v[0], at: +v[1] });
            }
        }
    } catch { /* a fresh day */ }
}

function saveScore(force = false) {
    const t = Date.now();
    if (!force && t - st.savedAt < SAVE_EVERY_MS) return;
    st.savedAt = t;
    try {
        fs.mkdirSync(path.dirname(FILE), { recursive: true });
        const picks = {};
        for (const [k, v] of remembered) if (t - v.at <= REMEMBER_MS) picks[k] = [v.team, v.at];
        fs.writeFileSync(FILE, JSON.stringify({ day: st.day, blue: st.score[BLUE], red: st.score[RED], lastWinner: st.lastWinner, picks }));
    } catch { /* kept in memory */ }
}

function rollDay(t) {
    const d = dayKey(t);
    if (d === st.day) return;
    const b = st.score[BLUE], r = st.score[RED];
    const winner = b === r ? 0 : b > r ? BLUE : RED;
    st.lastWinner = winner ? L.teamNo(winner) : 0;
    if (winner) hook('announce', 'teamday', L.teamName(winner) + " won the day!", "Final score " + b.toLocaleString('en-US') + " to " + r.toLocaleString('en-US') + ". A new day starts now.", 6000);
    st.score[BLUE] = 0; st.score[RED] = 0;
    st.day = d;
    saveScore(true);
}

function warNeed(team) {
    let n = 0;
    for (const b of fighters()) if (b.team === team) n++;
    return Math.max(WAR_MIN, Math.min(WAR_MAX, WAR_PER_PLAYER * Math.max(4, n)));
}

function addScore(team, n) {
    if (!active || !L.isTeam(team) || !(n > 0)) return;
    st.score[team] += Math.round(n);
}

function addWar(team, n, t = Date.now()) {
    if (!active || !L.isTeam(team) || !(n > 0)) return;
    const need = warNeed(team);
    if (st.warFull[team]) return;
    st.war[team] = Math.min(need, st.war[team] + n);
    if (st.war[team] >= need) { st.warFull[team] = true; if (!st.fullAt[team]) st.fullAt[team] = t; }
}

function warFrac(team) { return st.warFull[team] ? 1 : Math.min(1, st.war[team] / warNeed(team)); }

function onBanked(body, amount) {
    const team = teamOf(body);
    if (!team) return;
    addScore(team, amount);
    addWar(team, amount);
}

function onKill(killer, victim) {
    const kt = teamOf(killer), vt = teamOf(victim);
    if (!kt || kt === vt) return;
    const pts = victim && victim.socket ? KILL_PTS : BOT_KILL_PTS;
    addScore(kt, pts);
    addWar(kt, pts);
}

function onBattleEnd(ev, awards) {
    if (!active || !ev) return;
    const by = { [BLUE]: 0, [RED]: 0 };
    for (const a of awards || []) {
        const b = a && (a.body || (a.key && hook('bodyOfKey', a.key)));
        const team = b ? teamOf(b) : (a && L.isTeam(a.team) ? a.team : 0);
        if (team) by[team] += Math.max(0, a.score | 0 || a.pts | 0 || 1);
    }
    if (by[BLUE] === by[RED]) return;
    const winner = by[BLUE] > by[RED] ? BLUE : RED;
    addScore(winner, BATTLE_PTS);
    addWar(winner, BATTLE_PTS);
    hook('announce', 'teambattle', L.teamName(winner) + " won the " + (ev.name || "battle"), "+" + BATTLE_PTS.toLocaleString('en-US') + " team points and War Meter.", 4200);
}

function onSiege(team, pts) { addScore(team, pts); }

function onTitanKilled(titanBody, killerTeam, bounty) {
    if (!L.isTeam(killerTeam)) return;
    addScore(killerTeam, bounty);
    addWar(killerTeam, Math.round(bounty * 0.5));
}

function warPadOf(team) { return L.warPads().find(p => p.team === team) || null; }
function onWarPad(body) {
    const team = teamOf(body);
    if (!team || !alive(body)) return false;
    const p = warPadOf(team);
    return !!p && Math.hypot(body.x - p.x, body.y - p.y) <= p.r + (body.realSize || 30) * 0.35;
}

function callState(team, t = Date.now()) {
    const frac = warFrac(team);
    const smallReady = t >= st.smallCdUntil[team];
    const titanOut = titan().aliveFor(team);
    const tcd = titan().cooldownLeft(team, t);
    return {
        radar: smallReady && frac >= CALLS.radar.cost,
        supply: smallReady && frac >= CALLS.supply.cost,
        titan: frac >= 1 && !titanOut && tcd <= 0,
        smallCd: Math.max(0, Math.ceil((st.smallCdUntil[team] - t) / 1000)),
        titanOut: !!titanOut,
        titanCd: Math.ceil(tcd / 1000),
    };
}

function spend(team, cost) {
    const need = warNeed(team);
    st.war[team] = cost >= 1 ? 0 : Math.max(0, st.war[team] - Math.round(need * cost));
    st.warFull[team] = false;
    st.fullAt[team] = 0;
}

function sayTo(body, text) { try { if (body && body.socket) body.sendMessage(text); } catch { /* */ } }

function voterKey(body) {
    if (!body) return null;
    const sk = body.socket;
    if (!sk) return body.isBot ? 'b:' + body.id : null;
    return sk.account && sk.account.id ? 'a:' + sk.account.id : 'g:' + (sk.guestId || body.id);
}
function humansOn(team) { return fighters().filter(b => b.team === team && b.socket && !b.isBot); }
function votersOn(team) { return fighters().filter(b => b.team === team && (b.socket || b.isBot)); }
function botChoice(team, bot, opts, t) {
    const foe = L.other(team);
    const w = { radar: 1, supply: 1, titan: opts.titan ? 2 : 0 };
    const behind = (st.score[foe] | 0) - (st.score[team] | 0);
    if (behind > 0) w.titan *= 1.8;
    if (titan().aliveFor(foe)) { w.radar += 1.5; w.supply += 0.5; }
    if (bot && bot.health && bot.health.max > 0 && bot.health.amount / bot.health.max < 0.5) w.supply += 1.2;
    const enemiesNearBase = fighters().filter(b => b.team === foe && L.inBase && L.inBase(team, b.x, b.y, 900)).length;
    if (enemiesNearBase >= 2) w.radar += 1;
    const kinds = POLL_KINDS.filter(k => opts[k] && w[k] > 0);
    let total = 0;
    for (const k of kinds) total += w[k];
    let r = Math.random() * total;
    for (const k of kinds) { r -= w[k]; if (r < 0) return k; }
    return kinds[kinds.length - 1] || 'supply';
}
function pollOptions(team, t = Date.now()) {
    return { radar: true, supply: true, titan: !titan().aliveFor(team) && titan().cooldownLeft(team, t) <= 0 };
}
function pollCounts(p) {
    const n = { radar: 0, supply: 0, titan: 0 };
    if (p) for (const v of p.votes.values()) if (n[v] != null) n[v]++;
    return n;
}
function pollWinner(p, opts) {
    const n = pollCounts(p);
    const avail = POLL_KINDS.filter(k => opts[k]);
    const top = Math.max(...avail.map(k => n[k]));
    const tied = avail.filter(k => n[k] === top);
    if (tied.length === 1) return tied[0];
    if (tied.includes('titan')) return 'titan';
    return tied[Math.floor(Math.random() * tied.length)];
}
function vote(body, kind, t = Date.now()) {
    if (!active || !alive(body)) return false;
    const team = teamOf(body);
    const p = team && st.poll[team];
    const key = voterKey(body);
    if (!p || !key) return false;
    if (!POLL_KINDS.includes(kind) || !pollOptions(team, t)[kind]) {
        if (kind === 'titan') sayTo(body, "Your Titan is still out or cooling down, so pick something else.");
        return false;
    }
    p.votes.set(key, kind);
    return true;
}
function request(body, kind, laneName, t = Date.now()) { return vote(body, kind, t); }
function fireCall(team, kind, t) {
    if (kind === 'titan') {
        if (launchTitan(team, Math.random() < 0.3 ? 'flank' : 'middle', null, t)) return true;
        kind = 'supply';
    }
    if (kind === 'radar') {
        spend(team, CALLS.radar.cost);
        st.radarUntil[team] = t + RADAR_MS;
        hook('teamCallout', team, 'radar', "Radar Sweep", "Your team voted for a Radar Sweep. Every enemy is lit up for 15 seconds.", 2600);
        hook('teamCallout', L.other(team), 'radarfoe', "You've been spotted", "The " + L.teamName(team) + " team can see everyone for 15 seconds.", 2600);
        return true;
    }
    const ok = hook('supplyTeam', team, L.supplySpots(team), t);
    if (!ok) { st.pollRetryAt[team] = t + POLL_RETRY_MS; return false; }
    spend(team, CALLS.supply.cost);
    hook('teamCallout', team, 'supply', "Supply Drop", "Your team voted for a Supply Drop. Two crates are landing in your base yard.", 3000);
    return true;
}
function tickPolls(t) {
    for (const team of TEAMS) {
        const full = warFrac(team) >= 1;
        if (!full) { st.poll[team] = null; st.fullAt[team] = 0; continue; }
        if (!st.fullAt[team]) st.fullAt[team] = t;
        let p = st.poll[team];
        if (!p) {
            if (t < st.pollRetryAt[team]) continue;
            const botAt = new Map();
            for (const b of votersOn(team)) if (!b.socket) botAt.set(b.id, t + BOT_VOTE_MIN_MS + Math.random() * (BOT_VOTE_MAX_MS - BOT_VOTE_MIN_MS));
            st.poll[team] = { openedAt: t, votes: new Map(), botAt };
            hook('teamCallout', team, 'poll', "War Meter full", "Vote on what your team gets next.", 2600);
            continue;
        }
        const opts = pollOptions(team, t);
        const voters = votersOn(team);
        for (const b of voters) {
            if (b.socket) continue;
            let at = p.botAt.get(b.id);
            if (at == null) { at = t + BOT_VOTE_MIN_MS + Math.random() * (BOT_VOTE_MAX_MS - BOT_VOTE_MIN_MS); p.botAt.set(b.id, at); }
            const key = voterKey(b);
            if (t >= at && !p.votes.has(key)) p.votes.set(key, botChoice(team, b, opts, t));
        }
        const keys = new Set(voters.map(voterKey).filter(Boolean));
        for (const [k, v] of p.votes) if (!keys.has(k) || !opts[v]) p.votes.delete(k);
        const age = t - p.openedAt;
        const allIn = keys.size > 0 && [...keys].every(k => p.votes.has(k));
        const due = allIn || age >= POLL_MS;
        if (!due) continue;
        const kind = pollWinner(p, opts);
        st.poll[team] = null;
        fireCall(team, kind, t);
    }
}
function pollFor(team, body, t = Date.now()) {
    const p = st.poll[team];
    if (!p) return null;
    const opts = pollOptions(team, t);
    const n = pollCounts(p);
    const mine = body ? p.votes.get(voterKey(body)) : null;
    const age = t - p.openedAt;
    const left = Math.max(0, Math.ceil((POLL_MS - age) / 1000));
    return {
        o: POLL_KINDS.map(k => opts[k] ? 1 : 0),
        n: POLL_KINDS.map(k => n[k]),
        m: mine ? POLL_KINDS.indexOf(mine) + 1 : 0,
        left,
        h: humansOn(team).length,
    };
}

function cancel(body) { if (body) body._tmChannel = null; }

function launchTitan(team, laneName, caller, t = Date.now()) {
    if (titan().aliveFor(team)) return false;
    const o = titan().launch(team, laneName, caller, t);
    if (!o) return false;
    spend(team, 1);
    const who = caller ? (caller.name || "A teammate") : "Your team";
    const route = laneName === 'flank' ? "around the flank" : "down the middle";
    hook('teamCallout', team, 'titan', "Titan called!", who + " sent your Titan " + route + ".", 3600);
    hook('teamCallout', L.other(team), 'titanfoe', L.teamName(team) + " Titan incoming", "It's coming " + route + ". Stop it before it reaches your base.", 4200);
    hook('feed', { titan: 1, t: L.teamNo(team), n: caller ? String(caller.name || '').slice(0, 16) : '' });
    return true;
}

function frontFighter(team) {
    let best = null, bd = Infinity;
    for (const b of fighters()) {
        if (b.team !== team) continue;
        const d = Math.hypot(b.x, b.y);
        if (d < bd) { bd = d; best = b; }
    }
    return best;
}

function tailVaults() {
    try { return (vault().getVaults() || []).filter(v => v.kind === 'tail'); } catch { return []; }
}

function tickTails(t, dt) {
    const fs0 = fighters();
    for (const v of tailVaults()) {
        let s = st.tail.get(v);
        if (!s) { s = { owner: v.team || v.homeTeam || 0, prog: 0, by: 0 }; st.tail.set(v, s); }
        const n = { [BLUE]: 0, [RED]: 0 };
        for (const b of fs0) if ((b.x - v.x) ** 2 + (b.y - v.y) ** 2 <= TAIL_R * TAIL_R) n[b.team]++;
        const present = TEAMS.filter(x => n[x] > 0);
        if (present.length === 1 && present[0] !== s.owner) {
            const by = present[0];
            if (s.by !== by) { s.by = by; s.prog = 0; }
            s.prog += dt * (1 + 0.25 * Math.min(3, n[by] - 1));
            if (s.prog >= TAIL_CAPTURE_MS) {
                const prev = s.owner;
                s.owner = by; s.prog = 0; s.by = 0;
                v.team = by;
                v.rainbow = false;
                hook('vaultsChanged');
                hook('teamCallout', by, 'tailtake', "Outpost taken", "Your team holds this Outpost now. You can bank and respawn there.", 3000);
                if (L.isTeam(prev)) hook('teamCallout', prev, 'taillost', "Outpost lost", "The " + L.teamName(by) + " team took one of your Outposts.", 3000);
                addScore(by, 300);
                addWar(by, 300);
            }
        } else if (present.length === 0 || (present.length === 1 && present[0] === s.owner)) {
            s.prog = Math.max(0, s.prog - dt * 1.5);
            if (s.prog === 0) s.by = 0;
        }
    }
}

function watchHits(body) {
    if (!body || body._tmHitWatch || typeof body.on !== 'function') return;
    body._tmHitWatch = true;
    body.on('damage', ({ damageInflictor = [] } = {}) => {
        for (const source of damageInflictor) {
            const root = rootOf(source);
            if (root && root.team !== body.team && (root.isBot || root.isPlayer || root.isTitan)) {
                body._tmHitBy = root; body._tmHitAt = Date.now();
                return;
            }
        }
    });
}

function busy(bot, t) {
    return t - Math.max(bot._lastDamageAt || 0, bot.hitAt || 0) < 2500 && bot._digWarsGoal === 'fight';
}

function keepOrder(orders, id, next) {
    const prev = st.orders.get(id);
    if (prev && prev.kind === next.kind && prev.target === next.target && prev.titan === next.titan && prev.human === next.human) {
        prev.until = next.until;
        if (next.x !== undefined) { prev.x = next.x; prev.y = next.y; }
        orders.set(id, prev);
        return;
    }
    orders.set(id, next);
}

function assignOrders(t) {
    const orders = new Map();
    const fs0 = fighters();
    const bots = fs0.filter(b => b.isBot && !b.socket);
    const taken = new Set();
    for (const [team, job] of st.jobs) {
        if (job && alive(job.bot)) {
            const p = warPadOf(team);
            keepOrder(orders, job.bot.id, { kind: 'warpad', x: p.x, y: p.y, r: Math.max(30, p.r * 0.4), until: t + 8000 });
            taken.add(job.bot.id);
        }
    }
    for (const team of TEAMS) {
        const foeTitan = titan().aliveFor(L.other(team));
        if (!foeTitan) continue;
        const mouth = L.sitesFor(team).mouth;
        if (Math.hypot(foeTitan.x - mouth.x, foeTitan.y - mouth.y) > 3200) continue;
        const mine = bots.filter(b => b.team === team && !taken.has(b.id));
        mine.sort((a, b) => Math.hypot(a.x - foeTitan.x, a.y - foeTitan.y) - Math.hypot(b.x - foeTitan.x, b.y - foeTitan.y));
        for (const b of mine.slice(0, Math.ceil(mine.length * DEFEND_SHARE))) {
            keepOrder(orders, b.id, { kind: 'defend', target: foeTitan, x: foeTitan.x, y: foeTitan.y, until: t + 6000 });
            taken.add(b.id);
        }
    }
    for (const team of TEAMS) {
        const own = titan().aliveFor(team);
        if (!own) continue;
        const mine = bots.filter(b => b.team === team && !taken.has(b.id) && !busy(b, t));
        mine.sort((a, b) => Math.hypot(a.x - own.x, a.y - own.y) - Math.hypot(b.x - own.x, b.y - own.y));
        for (const b of mine.slice(0, ESCORT_PER_TITAN)) {
            keepOrder(orders, b.id, { kind: 'escort', titan: own, x: own.x, y: own.y, until: t + 6000 });
            taken.add(b.id);
        }
    }
    for (const h of fs0) {
        if (!h.socket || h.isBot) continue;
        const atk = h._tmHitBy;
        if (!atk || !alive(atk) || t - (h._tmHitAt || 0) > HELP_HIT_MS || atk.team === h.team) continue;
        const near = bots.filter(b => b.team === h.team && !taken.has(b.id) && Math.hypot(b.x - h.x, b.y - h.y) < HELP_RANGE && !busy(b, t));
        near.sort((a, b) => Math.hypot(a.x - h.x, a.y - h.y) - Math.hypot(b.x - h.x, b.y - h.y));
        for (const b of near.slice(0, HELPERS_PER_HUMAN)) {
            keepOrder(orders, b.id, { kind: 'help', target: atk, human: h, x: atk.x, y: atk.y, until: t + 5000 });
            taken.add(b.id);
        }
    }
    st.orders = orders;
}

function botOrderFor(bot, t = Date.now()) {
    if (!active || !bot) return null;
    const o = st.orders.get(bot.id);
    if (!o || t > o.until) return null;
    if (o.target && !alive(o.target)) return null;
    if (o.titan && !alive(o.titan)) return null;
    if (o.target) { o.x = o.target.x; o.y = o.target.y; }
    if (o.titan) { o.x = o.titan.x; o.y = o.titan.y; }
    return o;
}

function bankSitesFor(team) {
    try { return (vault().getVaults() || []).filter(v => !v.team || v.team === team); } catch { return []; }
}

function canUseVault(v, body) { return !v || !v.team || !body || v.team === body.team; }
function canUseShop(s, body) { return !s || !s.team || !body || s.team === body.team; }

function spawnSpotFor(body) {
    const team = teamOf(body);
    if (!team) return null;
    const held = tailVaults().filter(v => v.team === team);
    const respawn = !!(body.socket ? body.socket.lastRaidDeathAt : body._botRespawned);
    if (respawn && held.length && Math.random() < TAIL_SPAWN_SHARE) {
        const v = held[(Math.random() * held.length) | 0];
        const enemyNear = fighters().some(b => b.team !== team && Math.hypot(b.x - v.x, b.y - v.y) < 900);
        if (!enemyNear) {
            const a = Math.random() * Math.PI * 2;
            return { x: v.x + Math.cos(a) * 190, y: v.y + Math.sin(a) * 190, tail: true };
        }
    }
    return L.baseSpawnSpot(team);
}

function tick(t = Date.now()) {
    if (!on()) return;
    if (!active) activate();
    const dt = st.tickAt ? Math.min(500, t - st.tickAt) : 0;
    st.tickAt = t;
    rollDay(t);
    tickTails(t, dt);
    tickPolls(t);
    if (t - st.orderAt >= 500) { st.orderAt = t; assignOrders(t); }
    try { titan().tick(t); } catch (e) { console.error('[TEAMS] titan tick', e && e.stack || e); }
    saveScore(false);
}

function snapshot(t = Date.now()) {
    if (!active) return undefined;
    const tails = tailVaults().map(v => {
        const s = st.tail.get(v) || {};
        return { x: Math.round(v.x), y: Math.round(v.y), t: L.teamNo(v.team), p: s.by ? Math.round(100 * s.prog / TAIL_CAPTURE_MS) / 100 : 0, c: L.teamNo(s.by || 0), n: v.name };
    });
    return {
        s: [st.score[BLUE], st.score[RED]],
        w: [Math.round(warFrac(BLUE) * 1000) / 1000, Math.round(warFrac(RED) * 1000) / 1000],
        wn: [warNeed(BLUE), warNeed(RED)],
        f: TEAMS.map(team => st.fullAt[team] ? Math.round((t - st.fullAt[team]) / 1000) : -1),
        rd: TEAMS.map(team => Math.max(0, Math.ceil((st.radarUntil[team] - t) / 1000))),
        ti: titan().snapshot(t),
        tails,
        pads: [],
        bases: TEAMS.map(team => ({ t: L.teamNo(team), ...L.baseRect(team) })),
        day: st.day,
        lw: st.lastWinner || 0,
        size: TEAM_SIZE,
    };
}

function forClient(client, body, t = Date.now()) {
    if (!active) return undefined;
    const team = body && L.isTeam(body.team) ? body.team : (client && client._tmTeam) || 0;
    if (!team) return undefined;
    const fs0 = fighters();
    const mates = [], foes = [];
    const radar = t < st.radarUntil[team];
    for (const b of fs0) {
        if (body && b === body) continue;
        if (b.team === team) { mates.push([b.id, Math.round(b.x), Math.round(b.y), b.isBot ? 1 : 0]); continue; }
        if (radar) foes.push([b.id, Math.round(b.x), Math.round(b.y)]);
    }
    const out = { t: L.teamNo(team), mates, foes, radar: radar ? 1 : 0 };
    out.poll = pollFor(team, body, t);
    if (body && alive(body)) {
        const cs = callState(team, t);
        out.pad = 0;
        out.can = [cs.radar ? 1 : 0, cs.supply ? 1 : 0, cs.titan ? 1 : 0];
        out.cd = cs.smallCd;
        out.tOut = cs.titanOut ? 1 : 0;
        out.tcd = cs.titanCd;
        if (body._tmChannel) out.ch = { k: body._tmChannel.kind, l: body._tmChannel.lane, p: Math.min(1, (t - body._tmChannel.startAt) / TITAN_CHANNEL_MS) };
    }
    return out;
}

function onPacket(socket, args) {
    if (!active || !socket || !socket.player) return;
    const body = socket.player.body;
    if (!alive(body)) return;
    const what = args && args[0];
    const kinds = { 1: 'radar', 2: 'supply', 3: 'titan', 4: 'titan' };
    const k = kinds[what];
    if (!k) return;
    vote(body, k);
}

function reset() {
    for (const team of TEAMS) { st.war[team] = 0; st.fullAt[team] = 0; st.smallCdUntil[team] = 0; st.radarUntil[team] = 0; st.poll[team] = null; st.pollRetryAt[team] = 0; st.warFull[team] = false; }
    st.orders = new Map();
    st.jobs = new Map();
    for (const v of tailVaults()) { v.team = v.homeTeam || 0; v.rainbow = !v.team; st.tail.set(v, { owner: v.team, prog: 0, by: 0 }); }
}

function scores() { return { blue: st.score[BLUE], red: st.score[RED] }; }

function debugInfo(body) {
    const fs0 = fighters();
    const count = team => fs0.filter(b => b.team === team).length;
    const bots = team => fs0.filter(b => b.team === team && b.isBot).length;
    return {
        active, score: scores(), war: [Math.round(st.war[BLUE]), Math.round(st.war[RED])], need: [warNeed(BLUE), warNeed(RED)],
        fighters: [count(BLUE), count(RED)], bots: [bots(BLUE), bots(RED)], protectors: st.protectors.filter(alive).length,
        tiles: baseTiles().length, titans: titan().snapshot(), orders: [...st.orders.values()].map(o => o.kind),
        me: body ? { team: body.team, x: Math.round(body.x), y: Math.round(body.y), color: body.color && body.color.base, onPad: onWarPad(body), ch: body._tmChannel ? 1 : 0 } : null,
        tails: tailVaults().map(v => ({ n: v.name, t: v.team })),
        vaults: (vault().getVaults() || []).map(v => ({ n: v.name, t: v.team, k: v.kind })),
    };
}
function isActive() { return active; }

module.exports = {
    TEAM_SIZE, KILL_PTS, BATTLE_PTS, CALLS, TITAN_CHANNEL_MS, BOT_CALL_AFTER_MS, AUTO_CALL_AFTER_MS, VISION_R,
    layout: L, on, isActive, attach, activate, deactivate, reset, tick, snapshot, forClient, onPacket,
    teamForHuman, teamForBot, botCap, applyColor, colorOf, teamOf, watchHits,
    onBanked, onKill, onBattleEnd, onSiege, onTitanKilled, addScore, addWar, warFrac, warNeed, scores,
    request, vote, pollFor, cancel, launchTitan, callState, onWarPad, warPadOf, botOrderFor, bankSitesFor, canUseVault, canUseShop,
    spawnSpotFor, tailVaults, debugInfo, inviteCode, joinCode,
};
