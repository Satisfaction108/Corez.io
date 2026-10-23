'use strict';

const fs = require('fs');
const path = require('path');
const L = require('./teamLayout.js');

const { BLUE, RED, TEAMS } = L;
const TEAM_SIZE = (() => { const n = parseInt(process.env.ROYALE_TEAM_SIZE, 10); return Number.isFinite(n) && n >= 2 ? n : 6; })();
const KILL_PTS = 100;
const BOT_KILL_PTS = 60;
const BATTLE_PTS = 1500;
const WAR_PER_PLAYER = 1600;
const WAR_MIN = 6000;
const WAR_MAX = 16000;
const CALLS = {
    radar: { cost: 0.25, name: 'Radar Sweep' },
    supply: { cost: 0.4, name: 'Supply Drop' },
    titan: { cost: 1, name: 'Titan' },
};
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
        smallCdUntil: { [BLUE]: 0, [RED]: 0 },
        radarUntil: { [BLUE]: 0, [RED]: 0 },
        day: dayKey(),
        lastWinner: 0,
        tail: new Map(),
        orders: new Map(),
        jobs: new Map(),
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
    return { ok: true, team: inv.team, by: inv.by };
}

function teamForHuman(socket, kept) {
    if (socket && L.isTeam(socket._tmTeam)) return socket._tmTeam;
    if (kept && L.isTeam(kept.team)) { if (socket) socket._tmTeam = kept.team; return kept.team; }
    const self = socket && socket._tmTeam;
    const c = countTeams();
    if (self) c.humans[self] = Math.max(0, c.humans[self] - 1);
    const team = pickSmaller(c.humans, c.all);
    if (socket) socket._tmTeam = team;
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
    } catch { /* a fresh day */ }
}

function saveScore(force = false) {
    const t = Date.now();
    if (!force && t - st.savedAt < SAVE_EVERY_MS) return;
    st.savedAt = t;
    try {
        fs.mkdirSync(path.dirname(FILE), { recursive: true });
        fs.writeFileSync(FILE, JSON.stringify({ day: st.day, blue: st.score[BLUE], red: st.score[RED], lastWinner: st.lastWinner }));
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
    const before = st.war[team];
    st.war[team] = Math.min(need, before + n);
    if (before < need && st.war[team] >= need && !st.fullAt[team]) {
        st.fullAt[team] = t;
        hook('teamCallout', team, 'warfull', "Titan ready", "Stand on your War Pad and hold to call it in.", 3200);
    }
}

function warFrac(team) { return Math.min(1, st.war[team] / warNeed(team)); }

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
    st.war[team] = Math.max(0, st.war[team] - Math.round(need * cost));
    if (st.war[team] < need) st.fullAt[team] = 0;
}

function sayTo(body, text) { try { if (body && body.socket) body.sendMessage(text); } catch { /* */ } }

function request(body, kind, laneName, t = Date.now()) {
    if (!active || !alive(body)) return false;
    const team = teamOf(body);
    if (!team) return false;
    if (!onWarPad(body)) { sayTo(body, "Stand on your War Pad to use the War Meter."); return false; }
    const cs = callState(team, t);
    if (kind === 'radar' || kind === 'supply') {
        if (!cs[kind]) {
            if (cs.smallCd > 0) sayTo(body, CALLS[kind].name + " is ready again in " + cs.smallCd + " seconds.");
            else sayTo(body, "The War Meter needs " + Math.round(CALLS[kind].cost * 100) + "% for a " + CALLS[kind].name + ".");
            return false;
        }
        spend(team, CALLS[kind].cost);
        st.smallCdUntil[team] = t + SMALL_CD_MS;
        if (kind === 'radar') {
            st.radarUntil[team] = t + RADAR_MS;
            hook('teamCallout', team, 'radar', "Radar Sweep", (body.name || "A teammate") + " lit up every enemy for 15 seconds.", 2600);
            hook('teamCallout', L.other(team), 'radarfoe', "You've been spotted", "The " + L.teamName(team) + " team can see everyone for 15 seconds.", 2600);
        } else {
            const ok = hook('supplyTeam', team, L.supplySpots(team), t);
            if (!ok) {
                st.war[team] += Math.round(warNeed(team) * CALLS.supply.cost);
                st.smallCdUntil[team] = 0;
                sayTo(body, "No crate could land right now, so your War Meter was refunded. Try again in a moment.");
                return false;
            }
            hook('teamCallout', team, 'supply', "Supply Drop", "Two crates are dropping in your base yard. Only your team can open them.", 3000);
        }
        return true;
    }
    if (kind === 'titan') {
        if (!cs.titan) {
            sayTo(body, cs.titanOut ? "Your Titan is already out there. You can still use Radar Sweep and Supply Drop."
                : cs.titanCd > 0 ? "Your team can call another Titan in " + cs.titanCd + " seconds."
                : "The War Meter needs to be full to call the Titan.");
            return false;
        }
        body._tmChannel = { kind: 'titan', lane: laneName === 'flank' ? 'flank' : 'middle', startAt: t, until: t + TITAN_CHANNEL_MS };
        return true;
    }
    return false;
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

function tickChannels(t) {
    for (const b of fighters()) {
        const ch = b._tmChannel;
        if (!ch) continue;
        if (!onWarPad(b) || !callState(b.team, t).titan) { b._tmChannel = null; continue; }
        if (t >= ch.until) {
            b._tmChannel = null;
            launchTitan(b.team, ch.lane, b, t);
        }
    }
}

function tickFullMeters(t) {
    for (const team of TEAMS) {
        if (st.fullAt[team] && warFrac(team) < 1) st.fullAt[team] = 0;
        if (!st.fullAt[team] && warFrac(team) >= 1) st.fullAt[team] = t;
        if (st.fullAt[team] && (titan().aliveFor(team) || titan().cooldownLeft(team, t) > 0)) st.fullAt[team] = t;
        if (!st.fullAt[team] || titan().aliveFor(team) || titan().cooldownLeft(team, t) > 0) { st.jobs.delete(team); continue; }
        const waited = t - st.fullAt[team];
        const someoneOnIt = fighters().some(b => b.team === team && b._tmChannel);
        if (someoneOnIt) continue;
        if (waited >= AUTO_CALL_AFTER_MS && callState(team, t).titan) { st.jobs.delete(team); launchTitan(team, 'middle', null, t); continue; }
        if (waited >= BOT_CALL_AFTER_MS) {
            const job = st.jobs.get(team);
            if (job && alive(job.bot) && job.bot.team === team) {
                if (onWarPad(job.bot) && !job.bot._tmChannel) request(job.bot, 'titan', job.lane, t);
                continue;
            }
            const pad = warPadOf(team);
            let best = null, bd = Infinity;
            for (const b of fighters()) {
                if (b.team !== team || !b.isBot || b.socket) continue;
                if (t - Math.max(b._lastDamageAt || 0, b.hitAt || 0) < 4000) continue;
                const d = Math.hypot(b.x - pad.x, b.y - pad.y);
                if (d < bd) { bd = d; best = b; }
            }
            if (best) st.jobs.set(team, { bot: best, lane: Math.random() < 0.3 ? 'flank' : 'middle', at: t });
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
    tickChannels(t);
    tickTails(t, dt);
    tickFullMeters(t);
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
        pads: L.warPads().map(p => ({ x: p.x, y: p.y, r: p.r, t: L.teamNo(p.team) })),
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
    if (body && alive(body)) {
        const onPad = onWarPad(body);
        const cs = callState(team, t);
        out.pad = onPad ? 1 : 0;
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
    const kinds = { 1: ['radar'], 2: ['supply'], 3: ['titan', 'middle'], 4: ['titan', 'flank'] };
    if (what === 0) { cancel(body); return; }
    const k = kinds[what];
    if (!k) return;
    request(body, k[0], k[1]);
}

function reset() {
    for (const team of TEAMS) { st.war[team] = 0; st.fullAt[team] = 0; st.smallCdUntil[team] = 0; st.radarUntil[team] = 0; }
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
    request, cancel, launchTitan, callState, onWarPad, warPadOf, botOrderFor, bankSitesFor, canUseVault, canUseShop,
    spawnSpotFor, tailVaults, debugInfo, inviteCode, joinCode,
};
