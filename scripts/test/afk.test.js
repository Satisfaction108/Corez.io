// AFK, dead links and ranked activity: node scripts/test/afk.test.js
//
//   rules    what counts as input (network/activity.js): a jittering or
//            zoom-rescaled cursor, held keys and toggles do not; the raid
//            activity rule, idle kills, idle players lose bot protection
//   loop     the real game loop in a child process (the chestKill pattern):
//            an autofire tank left alone keeps shooting and drifting, loses
//            its shield after a minute and is removed at exactly 5 minutes
//            (no death, no kill credit, no resume); a plain drop is resumable
//            for 45 s and gone after
//   hooks    rankHooks on a throwaway database: idle time earns no survival,
//            an idle kick settles with zero gain and no streak, the raid pays
//            no placement without real activity (or after an idle kick)
//   e2e      one local server (ports 4790-4793): an autofire AFK is kicked
//            to the menu (IK, close 4001) with no resume and a zero life; a
//            paused socket is dropped by the heartbeat within ~13 s, its tank
//            leaves the world, a reconnect within 45 s gets the life back,
//            after 45 s it is gone. AFK_E2E=0 skips it.
//
// Data goes under $DATA_DIR if set (point it at a scratch directory),
// otherwise the OS temp dir; it is removed when everything passes.
'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..', '..');
const SERVER = path.join(REPO, 'server');
const MIN = 60 * 1000;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// the timers must be the real ones, whatever the shell has set
for (const k of ['ROYALE_DEBUG', 'ROYALE_IDLE_KICK_MS', 'ROYALE_IDLE_PROTECT_MS', 'ROYALE_RESUME_MS', 'DEAD_LINK_MS']) delete process.env[k];

if (process.argv[2] === '--loop') loopPart();
else mainPart();

// ===================================================================
// loop: the game loop, in its own process (it owns the globals)
// ===================================================================

function loopPart() {
    const log = console.log;
    console.log = () => {};
    try {
        require(path.join(SERVER, 'loaders', 'loader.js'));
        new definitionCombiner({
            groups: path.join(SERVER, 'lib', 'definitions', 'groups'),
            addonsFolder: path.join(SERVER, 'lib', 'definitions', 'entityAddons'),
        }).loadDefinitions();
    } finally { console.log = log; }
    Config.dig_royale = true;

    const { gameHandler } = require(path.join(SERVER, 'game', 'index.js'));
    global.gameManager = {
        room: { width: 20000, height: 20000, topPlayerID: -1, isIn: () => false, getAt: () => null, isInNorm: () => true },
        views: [], minimap: [], roomSpeed: 1, runSpeed: 1, clients: [], terrainGrid: null,
        socketManager: { players: [], clients: [], broadcast() {} },
    };
    const handler = new gameHandler(global.gameManager);
    global.gameManager.gameHandler = handler;
    const loop = (n = 1) => { for (let i = 0; i < n; i++) handler.gameloop(); };

    const royale = require(path.join(SERVER, 'game', 'gamemodes', 'scripts', 'dig_royale.js'));
    const activity = require(path.join(SERVER, 'game', 'network', 'activity.js'));
    const botDiff = require(path.join(SERVER, 'miscFiles', 'botDifficulty.js'));
    const { ioTypes } = require(path.join(SERVER, 'miscFiles', 'controllers.js'));

    // Date.now as the raid sees it; the game loop keeps its own clock
    const realNow = Date.now.bind(Date);
    let skew = 0;
    Date.now = () => realNow() + skew;

    let seq = 0, nextY = -9000;
    function level45(t) {
        while (t.skill.level < 45) { t.skill.score += t.skill.levelScore; t.skill.maintain(); }
        t.refreshBodyAttributes();
    }
    function mkSocket(extra = {}) {
        const s = {
            id: 'loop' + (++seq), packets: [], closedWith: null, terminated: false, readyState: 1, OPEN: 1,
            status: {}, camera: { x: 0, y: 0 }, _careerLives: 100, resumeToken: 'tokLoop' + seq + 'abcdef',
            ...extra,
        };
        s.talk = (...a) => s.packets.push(a);
        s.close = (code, why) => { s.closedWith = [code, why]; };
        s.terminate = () => { s.terminated = true; };
        return s;
    }
    // a raid spawn the way sockets.js makes one: listenToPlayer on a command object
    function spawnTank(socket, cls = 'basic') {
        const t = new Entity({ x: 0, y: (nextY += 1500) });
        t.define(cls);
        t.isPlayer = true;
        t.team = -1 - (nextY & 0xff);
        t.name = 'Afk' + seq;
        t.alwaysActive = true;
        t.reverseTank = 1;
        const player = {
            socket, body: t, target: { x: 120, y: 0 },
            command: { up: 0, down: 0, left: 0, right: 0, lmb: 0, mmb: 0, rmb: 0, sidearm: 0, autofire: false, autospin: false, override: false, autoalt: false, spinlock: false },
        };
        socket.player = player;
        t.socket = socket;
        t.become(player);
        level45(t);
        global.gameManager.socketManager.clients.push(socket);
        global.gameManager.socketManager.players.push(player);
        royale.onHumanJoin(t);
        return t;
    }
    function bot(x, y) {
        const b = new Entity({ x, y });
        b.define('basic');
        b.isBot = true;
        b.team = -500 - (nextY & 0xff);
        b.name = 'Bot';
        b.alwaysActive = true;
        b.botSkill = 0.5;
        level45(b);
        b.controllers = [];
        return b;
    }
    const ltests = [];
    const ltest = (name, fn) => ltests.push({ name, fn });

    ltest('constants: 5 minute kick, 1 minute protection, 45 s resume', () => {
        assert.equal(activity.IDLE_KICK_MS, 5 * MIN);
        assert.equal(activity.IDLE_PROTECT_MS, MIN);
        assert.equal(royale.RESUME_MS, 45 * 1000);
    });

    ltest('sleeper: the spawn shield that waits for a first move lasts a minute of idling, not forever', () => {
        const sock = mkSocket();
        const tank = spawnTank(sock);
        tank.spawnGraceUntil = 0;
        activity.noteCommand(sock, 120, 0, 0);
        const base = sock.lastInputAt;
        const at = (ms) => { skew = base + ms - realNow(); return Date.now(); };
        loop(3);
        assert.equal(tank.invuln, true, 'nothing pressed: still shielded');
        royale._tickIdle(at(30 * 1000));
        assert.equal(tank.invuln, true, 'shield at 30 s idle');
        assert.equal(activity.unprotected(tank, Date.now()), false);
        royale._tickIdle(at(61 * 1000));
        assert.equal(tank.invuln, false, 'shield off after a minute idle');
        assert.ok(sock.packets.some(p => p[0] === 'm' && /idle for a minute/.test(p[2])));
        assert.equal(activity.unprotected(tank, Date.now()), true);
        tank.kill();
        loop(2);
        skew = 0;
    });

    ltest('autofire AFK: keeps shooting and drifting, removed at exactly 5 min with no death and no resume', () => {
        const sock = mkSocket();
        const tank = spawnTank(sock);
        tank.spawnGraceUntil = 0;
        let deaths = 0;
        tank.on('dead', () => deaths++);
        // the only things this player ever does: one aim, autofire on, then a
        // cursor that jitters in place (a cheap anti-AFK trick) with the same bits
        activity.noteCommand(sock, 120, 0, 0);
        const base = sock.lastInputAt;
        const at = (ms) => { skew = base + ms - realNow(); return Date.now(); };
        loop();
        sock.player.command.autofire = true;         // the 't' toggle: not input
        const x0 = tank.x, y0 = tank.y;
        const before = new Set(entities.keys());
        let fresh = 0;
        for (let i = 0; i < 90; i++) {
            if (activity.noteCommand(sock, 120 + (i % 3) - 1, (i % 5) - 2, 0)) fresh++;
            loop();
        }
        const shots = [...entities.values()].filter(e => !before.has(e.id) && (e.master === tank || e.source === tank));
        assert.ok(shots.length > 3, 'autofire kept firing: ' + shots.length);
        assert.ok(Math.hypot(tank.x - x0, tank.y - y0) > 5, 'recoil drifted the tank');
        assert.equal(fresh, 0, 'jitter never counted');
        assert.equal(sock.lastInputAt, base);
        royale._tickIdle(at(4 * MIN));
        assert.equal(activity.unprotected(tank, Date.now()), true, 'bots stopped sparing it');
        // not kicked a moment early
        royale._tickIdle(at(5 * MIN - 1000));
        assert.equal(sock._idleKicked, undefined);
        assert.ok(entities.has(tank.id));
        royale._tickIdle(at(5 * MIN));
        assert.equal(sock._idleKicked, true, 'kicked at 5 minutes');
        const ik = sock.packets.find(p => p[0] === 'IK');
        assert.ok(ik, 'IK sent');
        assert.equal(ik[1], 'Removed for being inactive for 5 minutes');
        assert.deepEqual(sock.closedWith, [4001, 'idle']);
        assert.equal(sock.leftOnPurpose, true);
        assert.ok(!entities.has(tank.id), 'the tank is out of the world at once');
        assert.equal(sock.player.body, null);
        loop(3);
        assert.equal(deaths, 0, 'no death event, so nobody is credited a kill');
        // the same tab reconnects: nothing to resume
        const again = mkSocket({ resumeToken: sock.resumeToken });
        assert.equal(royale.claimResume(again, sock.resumeToken), false, 'no resume after an idle kick');
        skew = 0;
    });

    ltest('chat keeps a player from the kick but not from losing protection; frozen time is not idle', () => {
        const sock = mkSocket();
        const tank = spawnTank(sock);
        activity.noteCommand(sock, 120, 0, 0);
        const base = sock.lastInputAt;
        const at = (ms) => { skew = base + ms - realNow(); return Date.now(); };
        activity.noteChat(sock, at(4 * MIN));
        royale._tickIdle(at(5 * MIN + 10));
        assert.equal(sock._idleKicked, undefined, 'chatted a minute ago');
        assert.equal(activity.unprotected(tank, Date.now()), true, 'but bots stopped sparing them');
        tank.royaleFrozen = true;
        royale._tickIdle(at(10 * MIN));
        assert.equal(sock._idleKicked, undefined, 'frozen by the raid');
        tank.royaleFrozen = false;
        royale._tickIdle(Date.now());
        assert.equal(sock._idleKicked, undefined, 'the clock restarted when the freeze ended');
        tank.kill();
        loop(2);
        skew = 0;
    });

    ltest('bots: an idle newcomer gets no grace, no soft window, no newcomer difficulty', () => {
        const G = ioTypes.digWarsGoals;
        const b = bot(0, (nextY += 1500));
        const ctl = new G(b);
        const sock = mkSocket({ _careerLives: 0, _careerPlayMs: 0 });
        const p = spawnTank(sock);
        p.x = b.x + 600; p.y = b.y;
        p.invuln = false;
        activity.noteCommand(sock, 120, 0, 0);
        loop(2);
        assert.equal(p.botNewbie, true, 'a brand new player');
        let now = Date.now();
        ctl.senseAt = 0; ctl.sense(now);
        assert.equal(ctl.view.enemy, null, 'playing: left alone (grace and soft window)');
        assert.equal(botDiff.of(p, now), 0);
        skew = 61 * 1000;
        now = Date.now();
        ctl.senseAt = 0; ctl.sense(now);
        assert.equal(ctl.view.enemy, p, 'idle a minute: fair game');
        assert.equal(ctl.canInitiateFight(p, now), true);
        assert.ok(botDiff.of(p, now) >= botDiff.NEUTRAL, 'normal difficulty');
        // one real input and the protection is back
        activity.noteCommand(sock, 0, 120, 0, now);
        assert.equal(botDiff.of(p, now), 0);
        p.kill(); b.kill();
        loop(2);
        skew = 0;
    });

    ltest('drop: the tank leaves, the raid is resumable for 45 s and gone after', () => {
        const sock = mkSocket();
        const tank = spawnTank(sock);
        activity.noteCommand(sock, 120, 0, 0);
        tank.carriedGems = 0;
        royale.disconnectCleanup(sock, tank);          // what sockets.close runs first
        const a = mkSocket({ resumeToken: sock.resumeToken });
        skew = 44 * 1000;
        assert.equal(royale.claimResume(a, sock.resumeToken), true, 'back within 45 s');
        assert.equal(a.lastInputAt, sock.lastInputAt, 'the idle clock came along: a reconnect is not input');
        a._resume = null;
        // a second drop, and nobody comes back in time
        skew = 0;
        const s2 = mkSocket();
        const t2 = spawnTank(s2);
        t2.carriedGems = 0;
        royale.disconnectCleanup(s2, t2);
        skew = 46 * 1000;
        assert.equal(royale.claimResume(mkSocket({ resumeToken: s2.resumeToken }), s2.resumeToken), false, 'gone after 45 s');
        skew = 0;
        tank.kill(); t2.kill();
        loop(2);
    });

    (async () => {
        let failed = 0;
        for (const t of ltests) {
            try { await t.fn(); console.log('ok   loop: ' + t.name); } catch (e) {
                failed++;
                console.log('FAIL loop: ' + t.name + '\n     ' + String(e && e.stack || e).split('\n').slice(0, 6).join('\n     '));
            }
        }
        process.exit(failed ? 1 : 0);
    })();
}

// ===================================================================
// main: rules, hooks, e2e
// ===================================================================

function mainPart() {
    const ROOT = process.env.DATA_DIR
        ? path.join(process.env.DATA_DIR, `afk-test-${process.pid}-${Date.now()}`)
        : fs.mkdtempSync(path.join(os.tmpdir(), 'dw-afk-test-'));
    const DATA_DIR = path.join(ROOT, 'data');
    const E2E_DATA_DIR = path.join(ROOT, 'e2e-data');
    const SECRET = 'afk-test-secret-0123456789-abcdefghijklmnopq';
    process.env.DATA_DIR = DATA_DIR;
    for (const k of ['DB_PATH', 'PUBLIC_HOST', 'PUBLIC_ORIGIN', 'ALLOWED_ORIGINS', 'ACCOUNTS_ALLOW_DEBUG']) delete process.env[k];
    process.env.NODE_ENV = 'test';
    process.env.ACCOUNTS_ENABLED = 'true';
    process.env.SESSION_SECRET = SECRET;

    const R = require('../../shared/ranks.js');
    const ranked = require('../../server/accounts/ranked');
    const accounts = require('../../server/accounts');
    const rankStore = require('../../server/accounts/rankStore');
    const activity = require('../../server/game/network/activity.js');
    const botDiff = require('../../server/miscFiles/botDifficulty.js');

    // ---- rules ----

    test('rules: jitter, a held key, a zoom rescale and toggles are not input; real moves and presses are', () => {
        const s = {};
        assert.equal(activity.noteCommand(s, 300, 0, 0, 1000), true, 'the first packet sets the anchor');
        let n = 0;
        for (let i = 0; i < 2000; i++) if (activity.noteCommand(s, 300 + (i % 7) - 3, (i % 9) - 4, 0, 2000 + i)) n++;
        assert.equal(n, 0, 'a cursor jittering in place never counts');
        assert.equal(s.lastInputAt, 1000);
        assert.equal(activity.noteCommand(s, 360, 0, 0, 5000), false, 'zoomed 20%: the same aim, rescaled');
        assert.equal(activity.noteCommand(s, 300 * Math.cos(0.3), 300 * Math.sin(0.3), 0, 5100), true, 'turned 17 degrees');
        // a key held down the whole time (a weight on W, lmb for autofire)
        assert.equal(activity.noteCommand(s, s._aimX, s._aimY, 16, 6000), true, 'pressed');
        for (let i = 0; i < 100; i++) assert.equal(activity.noteCommand(s, s._aimX, s._aimY, 16, 6100 + i), false);
        assert.equal(activity.noteCommand(s, s._aimX, s._aimY, 17, 7000), true, 'another key');
        // near the tank the angle is noise; it takes a real move
        const c = {};
        activity.noteCommand(c, 5, 5, 0, 0);
        assert.equal(activity.noteCommand(c, -5, -5, 0, 10), false);
        assert.equal(activity.noteCommand(c, 90, 30, 0, 20), true);
        // the idle clocks: chat holds off the kick, never the protection
        const k = { lastInputAt: 1000, _idleFrom: 500 };
        activity.noteChat(k, 50000);
        assert.equal(activity.idleMs(k, 60000), 10000);
        assert.equal(activity.inputIdleMs(k, 60000), 59000);
        activity.resetClock(k, 59000);
        assert.equal(activity.inputIdleMs(k, 60000), 1000);
        assert.equal(activity.IDLE_KICK_MS, 5 * MIN);
        assert.equal(activity.IDLE_PROTECT_MS, MIN);
    });

    test('rules: raid activity, idle kills, idle newcomers', () => {
        assert.equal(ranked.activeEnough({ inputMs: 3 * MIN, aliveMs: 5 * MIN }), true);
        assert.equal(ranked.activeEnough({ inputMs: 3 * MIN, aliveMs: 5.1 * MIN }), false, 'under 60% of the time alive');
        assert.equal(ranked.activeEnough({ inputMs: 2.9 * MIN, aliveMs: 3 * MIN }), false, 'under 3 active minutes');
        assert.equal(ranked.activeEnough({ inputMs: 20 * MIN, aliveMs: 20 * MIN, idleKicked: true }), false, 'kicked for idling');
        assert.equal(ranked.activeEnough(null), false);
        const ok = { place: 1, rows: 6, score: 500, raidMs: 10 * MIN };
        assert.equal(ranked.placementBonus(ok).rp, 40);
        assert.deepEqual(ranked.placementBonus({ ...ok, active: false }), { eligible: false, rp: 0, dustMilli: 0 });
        const f = ranked.killFilter({ victimIsBot: false, victimAliveMs: MIN, priorKills: 0, pts: 200, killerIdle: true });
        assert.deepEqual(f, { discount: 200, dustMilli: 0, spawnKill: false, filtered: true });
        // idle for a minute: newcomer and mercy softening are off
        const now = Date.now();
        const sock = { lastInputAt: now - 61000, botMercyUntil: now + 10000 };
        const newbie = { isPlayer: true, botNewbie: true, socket: sock };
        assert.equal(botDiff.of(newbie, now), botDiff.NEUTRAL);
        sock.lastInputAt = now - 1000;
        assert.equal(botDiff.of(newbie, now), 0);
        const vet = { isPlayer: true, botDifficulty: 0.8, socket: { lastInputAt: now - 61000, botMercyUntil: now + 10000 } };
        assert.equal(botDiff.of(vet, now), 0.8, 'no mercy while idle');
    });

    test('rules: the game loop (child process)', () => {
        const r = spawnSync(process.execPath, [__filename, '--loop'], { cwd: REPO, encoding: 'utf8', timeout: 120000, env: { ...process.env, DATA_DIR } });
        const out = (r.stdout || '') + (r.stderr || '');
        const lines = out.split('\n').filter(l => /^(ok|FAIL) /.test(l) || /^     /.test(l));
        if (r.status !== 0) throw new Error('loop part failed:\n' + (lines.join('\n') || out.slice(-3000)));
        return lines.filter(l => l.startsWith('ok')).length + ' loop checks';
    });

    // ---- hooks ----

    let rankHooks = null;
    const H = { stats: new Map(), clients: [], raidId: 1, order: null };
    let seq = 0;
    function mkUser() {
        const r = accounts.users.create({ username: ('afk_' + (++seq) + '_' + Math.floor(Math.random() * 1e4)).slice(0, 16), recoveryHash: null });
        assert.ok(r.ok, JSON.stringify(r));
        return r.user;
    }
    const D = () => accounts.db.handle();
    function mkSocket(user) {
        const s = { id: 'afk' + (++seq), account: user ? { id: user.id, publicId: user.public_id, username: user.username } : null, packets: [], terminated: false, player: { body: null } };
        s.talk = (type, ...args) => s.packets.push([type, ...args]);
        return s;
    }
    function mkBody(socket, extra = {}) {
        const b = { id: 5000 + (++seq), socket, rankCode: 0, dustCarried: 0, carriedGems: 0, isDead: () => false, isPlayer: true, x: 0, y: 0, ...extra };
        if (socket) socket.player.body = b;
        return b;
    }
    function mkStat(key) {
        const s = { key, banked: 0, kills: 0, killPts: 0, extra: 0, revengeBonus: 0, carried: 0, alive: true };
        H.stats.set(key, s);
        return s;
    }
    function player(user) {
        const sock = mkSocket(user);
        H.clients.push(sock);
        const body = mkBody(sock);
        const s = mkStat('s:' + sock.id);
        return { user, sock, body, s };
    }
    const packets = (sock, type) => sock.packets.filter(p => p[0] === type);
    function reset() { H.clients.length = 0; H.stats.clear(); H.order = null; }

    test('hooks: harness attaches', () => {
        global.Config = { dig_royale: true };
        rankHooks = require('../../server/accounts/game/rankHooks');
        rankHooks.attach({
            stats: () => H.stats, clients: () => H.clients, raidId: () => H.raidId,
            board: () => H.order || [...H.stats.values()].map(s => ({ s, score: (s.banked | 0) + (s.killPts | 0) })).sort((a, b) => b.score - a.score),
            resumeMs: 300, serverId: 'afk',
        });
        assert.equal(require('../../server/accounts/game/bridge').rankedOn(), true);
    });

    test('hooks: survival and input time only accrue with real input; a drifting AFK tank earns nothing', () => {
        const p = player(mkUser());
        rankHooks.onRaidStart();
        rankHooks.lifeStart(p.body, p.s);
        const t0 = Date.now();
        p.s.survAt = t0;
        let t = t0;
        // 10 idle minutes: autofire recoil pushes the tank around, no input at all
        for (let i = 0; i < 120; i++) { t += 5000; p.body.x += 200; rankHooks.surviveCheck(t); }
        assert.equal(p.s.lifeSurviveMs | 0, 0);
        assert.equal(p.s.lifeSurvivePts | 0, 0);
        assert.equal(p.s.lifeInputMs | 0, 0);
        // the spawn shield never ends while nobody touches anything: shielded
        // time with input counts as input time, not as survival
        p.body.invuln = true;
        for (let i = 0; i < 12; i++) { t += 5000; p.sock.lastInputAt = t; rankHooks.surviveCheck(t); }
        assert.equal(p.s.lifeSurviveMs | 0, 0);
        assert.equal(p.s.lifeInputMs, 60000);
        p.body.invuln = false;
        for (let i = 0; i < 12; i++) { t += 5000; p.sock.lastInputAt = t; rankHooks.surviveCheck(t); }
        assert.equal(p.s.lifeSurviveMs, 60000);
        assert.equal(p.s.lifeSurvivePts, R.REWARDS.survive.ptsPerMin);
        reset();
    });

    test('hooks: an idle kick settles with zero gain, no play streak, no placement life, and the raid pays no placement', () => {
        const rk = player(mkUser()), pl = player(mkUser());
        rankStore.debugSetRp(rk.user.id, 3000);
        H.raidId = 10;
        rankHooks.onRaidStart();
        for (const p of [rk, pl]) {
            rankHooks.lifeStart(p.body, p.s);
            p.s.lifeStartAt -= 8 * MIN;
            p.s.lifeInputMs = 2 * MIN;               // played a bit, then walked away
            p.s.banked = 900;                        // points from before they left
            p.s.lifeSurvivePts = 20; p.s.rankOnly = 20;
        }
        const pay = rankHooks.onIdleKick(rk.sock, rk.s);
        assert.equal(pay.reason, 'idle');
        assert.equal(pay.basis, 0);
        assert.equal(pay.gain, 0);
        assert.deepEqual(pay.parts, []);
        assert.ok(pay.delta <= 0, 'no progress: ' + pay.delta);
        assert.equal(pay.streak, null, 'an idle life never moves the play streak');
        const row = D().get('SELECT end_reason, basis, gain FROM rank_lives WHERE life_id = ?', rk.s.lifeId);
        assert.deepEqual(row, { end_reason: 'disconnect', basis: 0, gain: 0 });
        assert.equal(D().get("SELECT count(*) AS n FROM dust_ledger WHERE user_id = ? AND kind = 'streak_play'", rk.user.id).n, 0);
        // in placement: not one of the three placement games
        const payP = rankHooks.onIdleKick(pl.sock, pl.s);
        assert.equal(payP.gain, 0);
        assert.equal(D().get('SELECT placement_lives FROM users WHERE id = ?', pl.user.id).placement_lives, 0);
        // they come back and really play the rest of the raid: still no placement
        rankHooks.lifeStart(rk.body, rk.s);
        rk.s.lifeStartAt -= 6 * MIN;
        rk.s.lifeInputMs = 6 * MIN;
        rk.s.banked += 2000;
        rankHooks._raidAcct.get(rk.user.id).joinedAt -= 15 * MIN;
        rk.sock.packets.length = 0;
        rankHooks.onRaidEnd();
        const rkp = JSON.parse(packets(rk.sock, 'RKP')[0][1]);
        assert.equal(rkp.place, 1);
        assert.equal(rkp.bonusRP, 0);
        assert.equal(rkp.bonusDustMilli, 0);
        assert.equal(D().get('SELECT rp_bonus FROM raid_results WHERE user_id = ?', rk.user.id).rp_bonus, 0);
        reset();
    });

    test('hooks: placement needs 3 active minutes and 60% of the time alive', () => {
        const raid = (lifeMs, inputMs) => {
            const p = player(mkUser());
            H.raidId++;
            rankHooks.onRaidStart();
            rankHooks.lifeStart(p.body, p.s);
            p.s.lifeStartAt -= lifeMs;
            p.s.lifeInputMs = inputMs;
            p.s.lifeSurviveMs = inputMs;
            p.s.banked = 800;
            rankHooks._raidAcct.get(p.user.id).joinedAt -= Math.max(lifeMs, 6 * MIN);
            rankHooks.onRaidEnd();
            const rkp = JSON.parse(packets(p.sock, 'RKP')[0][1]);
            reset();
            return rkp.bonusRP;
        };
        assert.equal(raid(20 * MIN, 20 * MIN), 40, 'played the whole raid');
        assert.equal(raid(20 * MIN, 12.5 * MIN), 40, '62%');
        assert.equal(raid(20 * MIN, 11 * MIN), 0, '55%: mostly AFK');
        assert.equal(raid(20 * MIN, 0), 0, 'outlasted everyone without touching a key');
        assert.equal(raid(2.5 * MIN, 2.5 * MIN), 0, 'under 3 active minutes');
    });

    test('hooks: kills and damage by an idle player pay nothing', () => {
        const k = player(mkUser()), v = player(mkUser());
        rankHooks.lifeStart(k.body, k.s);
        rankHooks.lifeStart(v.body, v.s);
        const t = Date.now();
        const bot = { id: 1, isDead: () => false, royaleBornAt: t - 5 * MIN };
        k.sock.lastInputAt = t - 2 * MIN;
        k.s.killPts += 100;
        rankHooks.onKillCredited(k.body, k.s, bot, null, 100);
        assert.equal(k.s.lifeKillPts | 0, 0);
        assert.equal(k.s.rankDiscount, 100, 'the whole kill is taken off the basis');
        rankHooks.onPlayerDamaged(Object.assign(v.body, { team: -2, health: { max: 100 }, shield: { max: 100 } }), 200, [{ master: k.body }]);
        assert.equal(k.s.lifeDmgPts | 0, 0);
        // playing again: a bot kill pays its half
        k.sock.lastInputAt = t;
        k.s.killPts += 100;
        rankHooks.onKillCredited(k.body, k.s, bot, null, 100);
        assert.equal(k.s.lifeKillPts, 50);
        reset();
    });

    // ---- e2e ----

    class Client {
        constructor(port, { cookie, token, name }) {
            const WebSocket = require(path.join(REPO, 'node_modules', 'ws'));
            this.ft = require('../../server/lib/fasttalk.js');
            const headers = { Origin: 'http://localhost:' + port };
            if (cookie) headers.Cookie = cookie;
            this.log = [];
            this.closed = false;
            this.closeCode = null;
            this.frozen = false;
            this.name = name;
            this.token = token;
            this.spawnedOnce = false;
            this.ws = new WebSocket('ws://localhost:' + port, { headers });
            this.ws.binaryType = 'arraybuffer';
            this.ws.on('message', d => {
                const m = this.ft.decode(d);
                if (!m) return;
                const type = m.shift();
                this.log.push({ type, m, at: Date.now() });
                if (type === 'W') this.talk('k', '');
                if (type === 'w') { this.talk('RZ', this.token); this.talk('s', '', 1, 0, false, 0); }
                if (type === 'TG' && !this.spawnedOnce) { this.spawnedOnce = true; setTimeout(() => this.talk('s', this.name, 0, 0, false, 0), 200); }
            });
            this.ws.on('close', (code) => { this.closed = true; this.closeCode = code; });
            this.ws.on('error', err => { this.error = err; });
        }
        talk(...m) { if (this.frozen) return; try { this.ws.send(this.ft.encode(m)); } catch (e) { /* closed */ } }
        mark() { return this.log.length; }
        async waitFor(type, pred = () => true, from = 0, ms = 20000) {
            const end = Date.now() + ms;
            while (Date.now() < end) {
                const hit = this.log.slice(from).find(e => e.type === type && pred(e.m));
                if (hit) return hit;
                await sleep(50);
            }
            throw new Error(`timed out waiting for ${type}; saw ${[...new Set(this.log.slice(from).map(e => e.type))].join(',')}`);
        }
        async dbg(...args) {
            const i0 = this.mark();
            this.talk('DBG', ...args);
            return JSON.parse((await this.waitFor('KC', m => m[0] === 'dbg', i0, 5000)).m[1]);
        }
        // a real input: the aim swings to another side
        poke() { this._side = ((this._side | 0) + 1) % 4; const a = this._side * Math.PI / 2; this.talk('C', Math.round(200 * Math.cos(a)), Math.round(200 * Math.sin(a)), 1, 0); }
        keepActive(ms = 2000) { this.stopActive(); this._act = setInterval(() => this.poke(), ms); }
        stopActive() { if (this._act) clearInterval(this._act); this._act = null; }
        // a laptop lid: nothing read, nothing sent, no pongs
        freeze() { this.stopActive(); this.frozen = true; try { this.ws._socket.pause(); } catch (e) { /* */ } }
        kill() { this.stopActive(); try { this.ws.terminate(); } catch (e) { /* */ } }
        close() { this.stopActive(); if (this._jit) clearInterval(this._jit); try { this.ws.close(); } catch (e) { /* */ } }
        said(re, from = 0) { return this.log.slice(from).some(e => e.type === 'm' && re.test(String(e.m[e.m.length - 1]))); }
    }

    test('e2e: autofire AFK kicked to the menu, no resume, zero life; heartbeat drop, 45 s resume (local server)', async () => {
        if (process.env.AFK_E2E === '0') return 'skipped (AFK_E2E=0)';
        const port = 4790;
        const origin = 'http://localhost:' + port;
        const KICK_MS = 40000, PROTECT_MS = 10000;
        fs.mkdirSync(E2E_DATA_DIR, { recursive: true });
        const env = { ...process.env, ROYALE_DEBUG: '1', ACCOUNTS_ALLOW_DEBUG: '1',
            ROYALE_IDLE_KICK_MS: String(KICK_MS), ROYALE_IDLE_PROTECT_MS: String(PROTECT_MS),
            SESSION_SECRET: SECRET, DATA_DIR: E2E_DATA_DIR, PUBLIC_ORIGIN: origin, PUBLIC_HOST: 'localhost:' + port,
            TRUSTED_PROXIES: '127.0.0.1', SINGLE_PROCESS: 'true', PORT: String(port), BR_PORT: String(port),
            TUT_PORT: String(port + 1), DUO_PORT: String(port + 2), DW_PORT: String(port + 3) };
        delete env.NODE_ENV;
        for (const k of Object.keys(env)) if (/^DISCORD_/.test(k)) delete env[k];
        const logFile = path.join(ROOT, 'e2e-server.log');
        const out = fs.openSync(logFile, 'w');
        const child = spawn(process.execPath, ['index.js'], { cwd: REPO, env, stdio: ['ignore', out, out] });
        const clients = [];
        const { DatabaseSync } = require('node:sqlite');
        let db = null;
        try {
            for (let i = 0; i < 160; i++) {
                try { if ((await fetch(origin + '/api/config')).status === 200) break; } catch (e) { /* booting */ }
                await sleep(250);
            }
            let ready = false;
            for (let i = 0; i < 20 && !ready; i++) {
                const c = new Client(port, { name: 'Probe', token: 'tokProbe' + i + 'xxxx' });
                for (let j = 0; j < 20 && !c.log.some(x => x.type === 'W'); j++) await sleep(100);
                ready = c.log.some(x => x.type === 'W');
                c.spawnedOnce = true;
                c.close();
                if (!ready) await sleep(500);
            }
            assert.ok(ready, 'game socket never welcomed a client');
            const signup = async (username) => {
                const r = await fetch(origin + '/api/auth/signup', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username, password: 'correct-horse-9' }) });
                assert.equal(r.status, 201, 'signup ' + username);
                return r.headers.get('set-cookie').split(';')[0];
            };
            const tag = String(Math.floor(Math.random() * 900) + 100);
            const names = { a: 'Watch' + tag, b: 'Drop' + tag, k: 'Afk' + tag };
            const cookies = { a: await signup(names.a), b: await signup(names.b), k: await signup(names.k) };
            db = new DatabaseSync(path.join(E2E_DATA_DIR, 'digwars.db'));
            const q = (sql, ...a) => { const r = db.prepare(sql).get(...a); return r ? { ...r } : r; };
            const uid = n => q('SELECT id FROM users WHERE username = ?', n).id;
            const openLife = n => q('SELECT life_id FROM rank_lives WHERE user_id = ? AND ended_at IS NULL', uid(n));

            // the observer: stays active, lists the humans in the world
            const A = new Client(port, { cookie: cookies.a, token: 'tokWatch' + tag + 'aaaa', name: names.a });
            clients.push(A);
            await A.waitFor('AC');
            await sleep(500);
            A.keepActive();
            A.talk('DBG', 'god');
            const humans = async () => (await A.dbg('humans')).humans;

            // ---- the AFK: one press, autofire on, then only cursor jitter ----
            const K = new Client(port, { cookie: cookies.k, token: 'tokAfk' + tag + 'kkkkk', name: names.k });
            clients.push(K);
            await K.waitFor('AC');
            await sleep(5500);                               // past the spawn grace
            K.talk('DBG', 'god');                           // the bots must not end it first
            await K.dbg('score', 1500);                     // points from before they left
            K.talk('C', 200, 0, 1, 16);                      // lmb down: the last real input
            const kLastInput = Date.now();
            K.talk('t', 1, 0);                               // autofire on
            let jit = 0;
            K._jit = setInterval(() => { jit++; K.talk('C', 200 + (jit % 5) - 2, (jit % 3) - 1, 1, 16); }, 250);
            const kLife = openLife(names.k);
            assert.ok(kLife, 'the AFK has an open life');

            // ---- the drop: god, a satchel, then the lid closes ----
            const B = new Client(port, { cookie: cookies.b, token: 'tokDrop' + tag + 'bbbb', name: names.b });
            clients.push(B);
            await B.waitFor('AC');
            await sleep(5500);
            B.talk('DBG', 'god');
            B.talk('DBG', 'carry', 300);
            B.poke();
            await sleep(1500);
            const me0 = await B.dbg('me');
            assert.ok(me0.carried >= 300, 'carrying ' + me0.carried);
            const bLife = openLife(names.b);
            assert.ok(bLife);
            assert.ok((await humans()).includes(names.b));
            await sleep(9000);                               // nothing hit it for the safe window
            const mePre = await B.dbg('me');
            B.freeze();
            const tFreeze = Date.now();
            let gone = 0;
            while (Date.now() - tFreeze < 25000) {
                if (!(await humans()).includes(names.b)) { gone = Date.now() - tFreeze; break; }
                await sleep(500);
            }
            assert.ok(gone > 0, 'the frozen tank never left the world');
            assert.ok(gone >= 9000 && gone <= 16500, 'dead link caught in ' + gone + ' ms');
            assert.ok(/Dropping the link/.test(fs.readFileSync(logFile, 'utf8')), 'the heartbeat dropped it');
            B.kill();

            // ---- meanwhile the AFK: shield long gone, kicked at the idle limit ----
            const ik = await K.waitFor('IK', () => true, 0, KICK_MS + 15000);
            const kickedAfter = ik.at - kLastInput;
            assert.ok(kickedAfter >= KICK_MS - 500 && kickedAfter <= KICK_MS + 2500, 'kicked ' + kickedAfter + ' ms after the last real input');
            assert.equal(ik.m[0], 'Removed for being inactive for 5 minutes');
            clearInterval(K._jit);
            for (let i = 0; i < 40 && !K.closed; i++) await sleep(100);
            assert.equal(K.closeCode, 4001, 'close code for the client');
            assert.ok(!(await humans()).includes(names.k), 'the AFK tank is gone');
            const kRow = q('SELECT end_reason, basis, gain, delta FROM rank_lives WHERE life_id = ?', kLife.life_id);
            assert.deepEqual(kRow, { end_reason: 'disconnect', basis: 0, gain: 0, delta: 0 });
            // same tab, same token: a fresh life, not the old one
            const K2 = new Client(port, { cookie: cookies.k, token: K.token, name: names.k });
            clients.push(K2);
            await K2.waitFor('AC');
            await sleep(1500);
            K2.keepActive();
            assert.equal(K2.said(/Reconnected/), false, 'no resume after an idle kick');
            const k2Life = openLife(names.k);
            assert.ok(k2Life && k2Life.life_id !== kLife.life_id);
            const pts = (await K2.dbg('rankpts')).rankpts;
            assert.equal(pts.raid.idleKicked, true);
            assert.equal(pts.raid.active, false, 'this raid pays them no placement');

            // ---- the drop comes back inside 45 s: the life, the satchel, the spot ----
            await sleep(Math.max(0, tFreeze + 22000 - Date.now()));
            const B2 = new Client(port, { cookie: cookies.b, token: B.token, name: names.b });
            clients.push(B2);
            await B2.waitFor('AC');
            await B2.waitFor('m', m => /Reconnected\. Your raid picked up/.test(String(m[m.length - 1])), 0, 10000);
            B2.keepActive();
            const me1 = await B2.dbg('me');
            assert.equal(me1.carried, me0.carried, 'satchel back');
            assert.ok(Math.hypot(me1.x - mePre.x, me1.y - mePre.y) < 200, 'back where it was: ' + JSON.stringify([mePre, me1]));
            assert.equal(openLife(names.b).life_id, bLife.life_id, 'the same ranked life');

            // ---- dropped again, and not back for 45 s: gone ----
            await sleep(1500);
            B2.freeze();
            const tFreeze2 = Date.now();
            while (Date.now() - tFreeze2 < 25000 && (await humans()).includes(names.b)) await sleep(500);
            assert.ok(!(await humans()).includes(names.b));
            B2.kill();
            await sleep(47000);
            const B3 = new Client(port, { cookie: cookies.b, token: B.token, name: names.b });
            clients.push(B3);
            await B3.waitFor('AC');
            await sleep(3000);
            B3.keepActive();
            assert.equal(B3.said(/Reconnected/), false, 'past the window: a fresh start');
            assert.equal(q('SELECT end_reason FROM rank_lives WHERE life_id = ?', bLife.life_id).end_reason, 'disconnect');
            return `dead link in ${(gone / 1000).toFixed(1)} s, idle kick at ${(kickedAfter / 1000).toFixed(1)} s (KICK_MS ${KICK_MS})`;
        } finally {
            for (const c of clients) c.close();
            if (db) try { db.close(); } catch (e) { /* */ }
            child.kill('SIGINT');
            await new Promise(res => { if (child.exitCode !== null) res(); else child.once('exit', res); setTimeout(res, 6000); });
            if (child.exitCode === null) child.kill('SIGKILL');
            fs.closeSync(out);
        }
    });

    (async () => {
        const quietLog = console.log, quietWarn = console.warn;
        console.log = (...args) => { if (!String(args[0]).startsWith('[accounts]')) quietLog(...args); };
        console.warn = (...args) => { if (!String(args[0]).startsWith('[accounts]')) quietWarn(...args); };
        assert.equal(accounts.initMain(), true, 'initMain');
        let failed = 0;
        const t0 = Date.now();
        for (const t of tests) {
            const s = Date.now();
            try {
                const note = await t.fn();
                quietLog(`ok   ${t.name} (${Date.now() - s} ms)${note ? ' - ' + note : ''}`);
            } catch (e) {
                failed++;
                quietLog(`FAIL ${t.name}\n     ${String(e && e.stack || e).split('\n').slice(0, 8).join('\n     ')}`);
            }
        }
        try { accounts.shutdown(); } catch (e) { /* */ }
        quietLog(`\n${tests.length - failed}/${tests.length} passed in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
        if (!failed) fs.rmSync(ROOT, { recursive: true, force: true });
        else quietLog('test data kept in ' + ROOT);
        process.exit(failed ? 1 : 0);
    })();
}
