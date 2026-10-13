// Early-game softening: node scripts/test/newcomer.test.js
//
//   shield     a raid spawn is shielded for 5 s; the soft window after it is
//              2 min for a new player and 25 s for anyone else
//   respawn    every death waits 3 s, new player or not, and the spawn loop
//              refuses an early drop; the F packet carries the wait; then
//              the card waits for Play again (only the raid end queues the
//              dead itself; playAgain.test.js runs it against a server);
//              15 minutes played ends "new" however few the lives
//   softBots   bots skip a soft player unless they come close or shoot,
//              never start a fight with one, and cap hunters per player
//   bosses     tuned health, one-in-two regen, and a boss hit takes about a
//              third of a fresh level-45 Basic at worst
//   deathLog   bot / player / boss / storm deaths land in the deaths table
//              for accounts and guests; the Discord /stats line reads them
//   migration  v5 -> v6 keeps every row, writes the backup, adds deaths
//
// Data goes under $DATA_DIR if set, otherwise the OS temp dir; it is removed
// when everything passes.
'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.join(__dirname, '..', '..');
const SERVER = path.join(REPO, 'server');
const ROOT = process.env.DATA_DIR
    ? path.join(process.env.DATA_DIR, `newcomer-test-${process.pid}-${Date.now()}`)
    : fs.mkdtempSync(path.join(os.tmpdir(), 'dw-newcomer-test-'));
fs.mkdirSync(ROOT, { recursive: true });

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
function loop(n = 1) { for (let i = 0; i < n; i++) handler.gameloop(); }

const royale = require(path.join(SERVER, 'game', 'gamemodes', 'scripts', 'dig_royale.js'));
const bosses = require(path.join(SERVER, 'game', 'terrain', 'bosses.js'));
const shop = require(path.join(SERVER, 'game', 'terrain', 'shop.js'));
const { ioTypes } = require(path.join(SERVER, 'miscFiles', 'controllers.js'));
const dbmod = require(path.join(SERVER, 'accounts', 'db'));
const migrations = require(path.join(SERVER, 'accounts', 'migrations'));
const deaths = require(path.join(SERVER, 'accounts', 'deaths'));
const FM = royale.FIRST_MINUTES;

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

let nextY = -9000;
function level45(t) {
    while (t.skill.level < 45) { t.skill.score += t.skill.levelScore; t.skill.maintain(); }
    t.refreshBodyAttributes();
}
function fakeSocket(extra = {}) {
    return { talk() {}, status: {}, camera: { x: 0, y: 0 }, _careerLives: 100, ...extra };
}
function player(x = 0, y = (nextY += 1200), socket = fakeSocket()) {
    const t = new Entity({ x, y });
    t.define('basic');
    t.isPlayer = true;
    t.team = -1 - (nextY & 0xff);
    t.name = 'Tester';
    t.alwaysActive = true;
    t.reverseTank = 1;
    t.socket = socket;
    t.sendMessage = () => {};
    level45(t);
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

// ===================================================================

test('shield: a raid spawn gets 5 s of shield; the soft window is 2 minutes only while new (3 in a first raid)', () => {
    assert.equal(royale.SPAWN_GRACE_MS, 5000);
    // a regular has the hours in too (the first raids director goes by time played)
    const p = player(0, (nextY += 1200), fakeSocket({ _careerPlayMs: 90 * 60_000 }));
    const t0 = Date.now();
    royale.freshRaidBody(p);
    assert.equal(p.invuln, true);
    assert.ok(Math.abs(p.spawnGraceUntil - (t0 + 5000)) < 200, 'grace ' + (p.spawnGraceUntil - t0));
    // a regular: a short window every life
    assert.equal(p.botNewbie, false);
    assert.ok(Math.abs(p.botSoftUntil - (t0 + FM.BOT_SOFT_SHORT_MS)) < 200);
    assert.ok(FM.BOT_SOFT_SHORT_MS >= 20_000 && FM.BOT_SOFT_SHORT_MS <= 30_000);
    // a new player: the full two minutes, three in their first raid
    // (terrain/newcomerDirector.js, newcomerDirector.test.js), and a longer
    // bot grace; bot behaviour only, the same health as anyone
    const n = player(0, (nextY += 1200), fakeSocket({ _careerLives: 0, _careerPlayMs: 0 }));
    royale.freshRaidBody(n);
    assert.equal(n.botNewbie, true);
    const director = require(path.join(SERVER, 'game', 'terrain', 'newcomerDirector.js'));
    const soft = director.isEnabled() ? director.TUNE.SOFT_MS[0] : FM.BOT_SOFT_MS;
    assert.ok(Math.abs(n.botSoftUntil - (t0 + soft)) < 200);
    assert.equal(FM.BOT_SOFT_MS, 120_000);
    assert.equal(FM.BOT_GRACE_MS, 15_000);
    assert.ok(Math.abs((n.botGraceUntil - t0) - FM.BOT_GRACE_NEW_MS) < 300, 'new: ' + FM.BOT_GRACE_NEW_MS + ' ms of bot grace');
    assert.ok(Math.abs((p.botGraceUntil - t0) - FM.BOT_GRACE_MS) < 300);
    assert.ok(Math.abs(n.health.max - p.health.max) < 1e-6, 'the same max health');
    p.kill(); n.kill();
    loop(2);
});

test('respawn: every death waits 3 s, new player or not', () => {
    const waits = (careerLives, lives) => {
        const out = [];
        const socket = fakeSocket({ _careerLives: careerLives });
        for (let i = 1; i <= lives; i++) {
            const p = player(0, (nextY += 1200), socket);
            royale.freshRaidBody(p);
            socket._royaleLives = i;   // the spawn path counts the life
            p.deathCause = 'storm';
            royale.onCombatantDead(p);
            out.push(Math.round((socket.royaleRespawnAt - Date.now()) / 100) / 10);
            p.kill();
        }
        return out;
    };
    assert.equal(royale.RESPAWN_MS, 3000);
    assert.deepEqual(waits(100, 5), [3, 3, 3, 3, 3]);
    assert.deepEqual(waits(0, 6), [3, 3, 3, 3, 3, 3]);
    // 15 minutes played is not new
    const long = fakeSocket({ _careerLives: 0, _careerPlayMs: 15 * 60_000 });
    const q = player(0, (nextY += 1200), long);
    royale.freshRaidBody(q);
    assert.equal(q.botNewbie, false);
    q.kill();
    loop(2);
    assert.equal(FM.NEW_RESPAWN_MS, undefined, 'no separate newcomer wait any more');
});

test('respawn: the spawn loop refuses a drop before the wait is up', () => {
    const src = fs.readFileSync(path.join(SERVER, 'game', 'network', 'sockets.js'), 'utf8');
    assert.ok(/if \(socket\.royaleRespawnAt && Date\.now\(\) < socket\.royaleRespawnAt\) return;/.test(src));
    // and a client can't skip the card: respawn() waits out raidRespawnAt
    const cv = fs.readFileSync(path.join(REPO, 'public', 'client', 'canvas.js'), 'utf8');
    // (it queues the drop for when the wait is up: round 6)
    assert.ok(/performance\.now\(\) < global\.raidRespawnAt;\n\s+if \(locked \|\| waiting\) \{[^}]*\n\s+return;/.test(cv));
});

test('respawn: the death card waits for Play again; only the raid end queues you itself', () => {
    const app = fs.readFileSync(path.join(REPO, 'public', 'client', 'app.js'), 'utf8');
    const card = app.slice(app.indexOf('const gameDrawDeadRoyale = () => {'), app.indexOf('function playAgainState()'));
    assert.ok(card.length > 1000, 'found the death card');
    assert.ok(!/\.respawn\(\)/.test(card), 'the death card never calls respawn() itself');
    assert.ok(/label: "Respawn in " \+ Math\.ceil\(waitMs \/ 1000\) \+ "\.\.\."/.test(app), 'counts the wait down on the button');
    assert.ok(/return \{ ready: true, label: "Respawn" \}/.test(app));
    assert.ok(/royaleDomBtn\("royaleDomPlayAgain", "Respawn"\)/.test(app));
    // Space and Enter press it; the server's spawn loop only starts on 's'
    const cv = fs.readFileSync(path.join(REPO, 'public', 'client', 'canvas.js'), 'utf8');
    assert.ok(/kc === 32 && global\.died[\s\S]{0,160}this\.respawn\(\)/.test(cv));
    const src = fs.readFileSync(path.join(SERVER, 'game', 'network', 'sockets.js'), 'utf8');
    assert.equal((src.match(/socket\._spawnLoop = setInterval/g) || []).length, 1);
    // the raid end is not a normal death: the finale still queues the dead
    const fin = fs.readFileSync(path.join(REPO, 'public', 'client', 'raidFinale.js'), 'utf8');
    assert.ok(/S\.respawnAsked = true;[\s\S]{0,260}try \{ global\.canvas\.respawn\(\); \}/.test(fin));
    // a pending update reloads on the card after the wait instead of holding a drop
    const ver = fs.readFileSync(path.join(REPO, 'public', 'client', 'version.js'), 'utf8');
    assert.ok(/performance\.now\(\) < global\.raidRespawnAt\) return "hold";\s+return "later";/.test(ver));
    assert.ok(/if \(global\.died && global\.updateHoldsRespawn\) return;/.test(cv), 'no drop the reload would cut short');
});

test('secondWind: the shield holds through movement for 10 s, never through shooting', () => {
    const socket = fakeSocket({ _careerLives: 100 });
    const st = shop.stateOf(socket);
    st.gear.wind = Date.now() + 60_000;
    const p = player(0, (nextY += 1200), socket);
    royale.freshRaidBody(p);
    assert.ok(Math.abs(p.spawnMoveShieldUntil - (Date.now() + shop.WIND_SHIELD_MS)) < 200);
    const q = player(0, (nextY += 1200), fakeSocket({ _careerLives: 100 }));
    royale.freshRaidBody(q);
    assert.equal(q.spawnMoveShieldUntil, 0, 'no gear, no extra shield');
    // the controller: past the 5 s grace, moving keeps it and shooting drops it
    const cmd = { up: false, down: false, left: false, right: false, lmb: false, autofire: false };
    const ctl = new ioTypes.listenToPlayer(p, { player: { command: cmd, target: { x: 0, y: 0 } } });
    const ctlQ = new ioTypes.listenToPlayer(q, { player: { command: cmd, target: { x: 0, y: 0 } } });
    ctl.think(); ctlQ.think();
    p.spawnGraceUntil = q.spawnGraceUntil = Date.now() - 1;
    cmd.up = true;
    ctl.think(); ctlQ.think();
    assert.equal(p.invuln, true, 'Second Wind: still shielded while moving');
    assert.equal(q.invuln, false, 'without it, moving drops the shield');
    cmd.lmb = true;
    ctl.think();
    assert.equal(p.invuln, false, 'shooting drops it');
    const item = shop.BY_ID.get('wind');
    assert.ok(/spawn shield/.test(item.desc) && !/respawn in/i.test(item.desc));
    p.kill(); q.kill();
    loop(2);
});

test('respawn: the death packet tells the client the same wait', () => {
    // records() puts royaleRespawnAt - now in the F packet's last slot
    const src = fs.readFileSync(path.join(SERVER, 'game', 'network', 'sockets.js'), 'utf8');
    assert.ok(/socket\.royaleRespawnAt \? Math\.max\(0, socket\.royaleRespawnAt - Date\.now\(\)\)/.test(src));
    const client = fs.readFileSync(path.join(REPO, 'public', 'client', 'socketinit.js'), 'utf8');
    assert.ok(/const waitMs = respawnWaitMs > 0 \? respawnWaitMs : 3000;\s+global\.raidRespawnAt = performance\.now\(\) \+ waitMs;/.test(client));
    // the death card goes up with the death packet, no killer cam in front of it
    assert.ok(/The death card shows at once[\s\S]{0,300}global\.royaleDied = true;/.test(client));
    const app = fs.readFileSync(path.join(REPO, 'public', 'client', 'app.js'), 'utf8');
    assert.ok(/const SHIELD_GRACE_MS = 5000;/.test(app), 'client shield hint counts down from 5');
});

test('softBots: soft players are skipped unless close or shooting, and bots never start the fight', () => {
    const G = ioTypes.digWarsGoals;
    const b = bot(0, (nextY += 1500));
    const ctl = new G(b);
    const p = player(b.x + 600, b.y);
    royale.freshRaidBody(p);
    p.invuln = false;
    p.botGraceUntil = 0;           // past the hard grace, still in the soft window
    p.botNewbie = false;
    loop(2);
    let now = Date.now();
    ctl.senseAt = 0; ctl.sense(now);
    assert.equal(ctl.view.enemy, null, 'a soft player at 600 is left alone');
    assert.equal(ctl.canInitiateFight(p, now), false);
    // walks right up: now the bot sees them (but still won't start a chase)
    p.x = b.x + 200; loop(1);
    now = Date.now() + 200;
    ctl.senseAt = 0; ctl.sense(now);
    assert.equal(ctl.view.enemy, p, 'close enough to be fought');
    assert.equal(ctl.canInitiateFight(p, now), false);
    // shoots the bot from range: the bot answers
    p.x = b.x + 600; loop(1);
    b._lastDamageSource = p; b._lastDamageAt = Date.now(); b._dmgBy = new Map([[p.id, b.health.max * 0.25]]); // round 9: 25% dealt
    now = Date.now() + 400;
    ctl.senseAt = 0; ctl.sense(now);
    assert.equal(ctl.view.enemy, p, 'the attacker is fought back');
    // soft window over, not new: a normal target again
    b._lastDamageSource = null; b._lastDamageAt = 0; b._dmgBy = null;
    p.botSoftUntil = 0;
    now = Date.now() + 600;
    ctl.senseAt = 0; ctl.sense(now);
    assert.equal(ctl.view.enemy, p);
    // a new player stays soft for the whole life
    p.botNewbie = true;
    now = Date.now() + 800;
    ctl.senseAt = 0; ctl.sense(now);
    assert.equal(ctl.view.enemy, null);
    p.botNewbie = false;
    // two other bots already on a player: a third leaves them alone
    const others = [bot(b.x - 300, b.y + 200), bot(b.x - 300, b.y - 200)];
    for (const o of others) o._botEnemyId = p.id;
    loop(1);
    for (const t = Date.now(); Date.now() - t < 130;);   // the shared bot scan refreshes every 110 ms
    now = Date.now() + 1000;
    ctl.senseAt = 0; ctl.sense(now);
    assert.equal(ctl.view.enemy === p, false, 'hunter cap');
    for (const o of [b, p, ...others]) o.kill();
    loop(2);
});

test('bots: builds, skill spread and shot damage are below a maxed player', () => {
    const b = bot(0, (nextY += 1500));
    b.botSkill = 0.8;
    handler.configureBotStats(b);
    const combat = b.skill.raw.slice(0, 10).reduce((a, v) => a + v, 0);
    assert.ok(combat <= 40, 'combat points ' + combat + ' (a level-45 player has 50)');
    const spawned = [];
    for (let i = 0; i < 40; i++) {
        handler.spawnBots({ x: 0, y: (nextY += 50) }, -900);
        spawned.push(handler.bots[handler.bots.length - 1]);
    }
    const mean = spawned.reduce((a, o) => a + o.botSkill, 0) / spawned.length;
    assert.ok(mean < 0.5 && spawned.every(o => o.botSkill <= 0.8), 'skill mean ' + mean.toFixed(2));
    assert.ok(spawned.every(o => o.botShotMult === 0.8));
    assert.equal(shotMult({ master: spawned[0] }), 0.8);
    for (const o of spawned) o.kill();
    b.kill();
    loop(2);
});

let bossWorst = 0;
// Contact damage depends a little on where in the world the hit lands (the
// thresholds below were set with the bosses at these spots), so the boss
// test keeps its own rows instead of following the tests before it.
let bossY = 400;
test('bosses: health x0.85, regen one tick in two, a hit takes at most about a third of a fresh Basic', () => {
    for (const [id, kind] of Object.entries(bosses.KINDS)) {
        const y = (bossY += 1500);
        const raw = new Entity({ x: 0, y });
        raw.define(kind.cls);
        raw.refreshBodyAttributes();
        const o = new Entity({ x: 0, y: y + 700 });
        o.define(kind.cls);
        o.isRoyaleBoss = true;
        o.team = -100;
        o.controllers = [];
        o.alwaysActive = true;
        bosses.tune(o, id);
        o.refreshBodyAttributes();
        // turrets hold fire so each shot is measured on its own
        for (const t of o.turrets.values()) t.controllers = [];
        assert.ok(Math.abs(o.health.max / raw.health.max - bosses.TUNING.healthMult) < 0.01, id + ' health');
        raw.kill();
        // regen: 8 regen ticks heal the boss 8 / regenEvery times
        o.health.amount = o.health.max * 0.5;
        o.shield.amount = o.shield.max;
        let heals = 0;
        for (let i = 0; i < 8; i++) {
            const before = o.health.amount;
            handler.regenHealthAndShield();
            if (o.health.amount > before) heals++;
        }
        assert.equal(bosses.TUNING.regenEvery, 2);
        assert.equal(heals, 4, id + ' regen ticks');
        o.health.amount = o.health.max;
        // every gun, hull and turrets, fired once point blank into a fresh Basic
        const guns = [...o.guns.values()];
        for (const t of o.turrets.values()) guns.push(...t.guns.values());
        for (const g of guns.filter(g => g.bulletType)) {
            // contact damage is noisy (overlap depth, relative speed): judge
            // the typical hit, allow one unlucky double contact in seven
            const hits = [];
            for (let rep = 0; rep < 7; rep++) {
                const p = player(400, o.y, fakeSocket());
                p.skill.set(Array(11).fill(0));
                p.refreshBodyAttributes();
                p.invuln = false;
                const pool = p.health.max + p.shield.max;
                const before = new Set(entities.keys());
                g.fire(0, 0);
                const made = [...entities.values()].filter(e => !before.has(e.id));
                if (!made.length) { p.kill(); continue; }
                for (const m of made.slice(1)) m.kill();
                const s = made[0];
                // the Wraith's hatches autofire, so its shards arrive as a
                // swarm, not one hit; they are small (about 2.5% each)
                if (s.type === 'drone') { s.kill(); p.kill(); loop(1); continue; }
                s.x = p.x - (p.realSize + (s.realSize || 8) + 4); s.y = p.y;
                s.velocity.x = Math.max(4, s.velocity.length || 0); s.velocity.y = 0;
                s.alwaysActive = true;
                loop(20);
                hits.push((pool - Math.max(0, p.health.amount) - Math.max(0, p.shield.amount)) / pool);
                try { s.kill(); } catch { /* */ }
                p.kill();
                loop(2);
            }
            hits.sort((a, b) => a - b);
            const typical = hits[hits.length >> 1] || 0, worst = hits[hits.length - 1] || 0;
            const pct = v => (v * 100).toFixed(1) + '%';
            assert.ok(typical <= 0.36, `${id} ${g.body.label}: a typical hit took ${pct(typical)}`);
            assert.ok(hits.filter(h => h > 0.45).length <= 1, `${id} ${g.body.label}: hits ${hits.map(pct).join(' ')}`);
            // the worst of seven can be a leftover shot landing too; never a one-shot
            assert.ok(worst < 0.9, `${id} ${g.body.label}: the worst hit took ${pct(worst)}`);
            bossWorst = Math.max(bossWorst, typical);
        }
        o.kill();
        loop(2);
    }
    // the hardest-hitting gun still takes a real bite (the 0.3 nerf left it at a fifth)
    assert.ok(bossWorst > 0.25, 'hardest typical hit ' + (bossWorst * 100).toFixed(1) + '%');
});

// ---- accounts DB ------------------------------------------------------
const dbFile = path.join(ROOT, 'deaths.db');
const d = dbmod.open({ path: dbFile, migrate: true, backupDir: path.join(ROOT, 'backups') });
dbmod.setCurrent(d);
d.run(`INSERT INTO users (id, public_id, username, username_lc, created_at) VALUES (7, 'DW-AAAAAAAA', 'Acct', 'acct', 1)`);

test('deathLog: bot, player, boss, storm deaths are logged with the killer and life length', () => {
    d.exec('DELETE FROM deaths');
    const die = (socket, cause, killer, lifeMs) => {
        const p = player(0, (nextY += 1200), socket);
        royale.freshRaidBody(p);
        socket._royaleLives = (socket._royaleLives | 0) + 1;
        p.royaleBornAt = Date.now() - lifeMs;
        if (cause === 'storm') p.deathCause = 'storm';
        if (killer) p.finalKillers = [killer];
        royale.onCombatantDead(p);
        p.kill();
    };
    const acct = fakeSocket({ account: { id: 7 } });
    const guest = fakeSocket({ guestId: 'a'.repeat(32) });
    const k = bot(3000, nextY);
    k.label = 'Twin';
    const killerPlayer = player(3000, (nextY += 1200));
    killerPlayer.name = 'Rival';
    const boss = new Entity({ x: 5000, y: nextY });
    boss.define('royaleVaultWarden');
    boss.isRoyaleBoss = true;
    boss.name = 'Vault Warden';
    die(acct, 'bot', k, 30_000);
    die(guest, 'bot', k, 50_000);
    die(guest, 'player', killerPlayer, 90_000);
    die(acct, 'boss', boss, 200_000);
    die(guest, 'storm', null, 400_000);
    const rows = d.all('SELECT * FROM deaths ORDER BY id');
    assert.deepEqual(rows.map(r => r.cause), ['bot', 'bot', 'player', 'boss', 'storm']);
    assert.equal(rows[0].user_id, 7);
    assert.equal(rows[0].guest_id, null);
    assert.equal(rows[1].guest_id, 'a'.repeat(32));
    assert.equal(rows[1].user_id, null);
    assert.equal(rows[0].killer_tank, 'Twin');
    assert.equal(rows[2].killer_name, 'Rival');
    assert.equal(rows[3].killer_name, 'Vault Warden');
    assert.equal(rows[4].killer_name, null);
    assert.ok(Math.abs(rows[0].life_ms - 30_000) < 500);
    assert.deepEqual(rows.map(r => r.life_no), [1, 1, 2, 2, 3]);
    const sum = deaths.summary(Date.now() - 60_000);
    assert.deepEqual([sum.total, sum.bot, sum.player, sum.boss, sum.storm], [5, 2, 1, 1, 1]);
    assert.ok(Math.abs(sum.medianLifeMs - 90_000) < 500);
    // raid-end deaths are not logged
    const p = player(0, (nextY += 1200), fakeSocket({ guestId: 'b'.repeat(32) }));
    royale.freshRaidBody(p);
    p.deathCause = 'raidend';
    royale.onCombatantDead(p);
    p.kill();
    assert.equal(d.get('SELECT count(*) AS n FROM deaths').n, 5);
    for (const o of [k, killerPlayer, boss]) o.kill();
    loop(2);
});

test('deathLog: the Discord /stats embed has the deaths line', () => {
    const src = fs.readFileSync(path.join(SERVER, 'accounts', 'discord', 'commands.js'), 'utf8');
    assert.ok(/name: 'Deaths \(24h\)', value: deathsText\(deaths\)/.test(src));
    const commands = require(path.join(SERVER, 'accounts', 'discord', 'commands'));
    assert.equal(commands.deathsText(deaths.summary(Date.now() - 60_000)),
        'bots 2, players 1, boss 1, storm 1, other 0 · median life 1.5 min');
    assert.equal(commands.deathsText(deaths.summary(Date.now() + 60_000)), 'none logged');
});

test('migration: v5 -> v6 keeps every row, writes a backup, adds deaths', () => {
    const file = path.join(ROOT, 'mig', 'v5.db');
    const db = dbmod.open({ path: file, migrate: false });
    db.tx(() => {
        for (const m of migrations.MIGRATIONS.filter(x => x.version <= 5)) m.up(db);
        db.exec('PRAGMA user_version = 5');
    });
    db.run(`INSERT INTO users (id, public_id, username, username_lc, created_at) VALUES (1, 'DW-BBBBBBBB', 'Old', 'old', 1)`);
    for (let i = 1; i <= 30; i++) {
        db.run('INSERT INTO dust_ledger (id, user_id, delta_milli, balance_milli, kind, ref, created_at) VALUES (?, 1, 100, ?, ?, ?, ?)',
            i * 2, i * 100, i % 2 ? 'gems' : 'streak_play', 'r' + i, i);
        db.run('INSERT INTO guests (guest_id, first_seen, last_seen, games) VALUES (?, 1, 2, ?)', i.toString(16).padStart(32, '0'), i);
    }
    const tables = db.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").map(t => t.name);
    const before = {};
    for (const t of tables) before[t] = db.all(`SELECT * FROM "${t}"`);
    assert.equal(db.get("SELECT 1 AS x FROM sqlite_master WHERE name = 'deaths'"), null);
    const res = migrations.apply(db, { backupDir: path.join(ROOT, 'mig', 'backups') });
    assert.deepEqual(res.applied, migrations.MIGRATIONS.filter(x => x.version >= 6).map(x => x.version));
    assert.ok(res.backup && fs.existsSync(res.backup), 'pre-migration backup');
    const bk = dbmod.open({ path: res.backup, migrate: false });
    assert.equal(bk.userVersion(), 5);
    assert.equal(bk.get('SELECT count(*) AS n FROM guests').n, 30);
    bk.close();
    assert.equal(db.userVersion(), migrations.latestVersion());
    // v7 adds guests.source (null for rows from before it), v9 users.bank_gems
    // and guests.bank_gems (0), v10 the sidekick columns (null)
    const strip = (t, rows) => rows.map(r => {
        const o = { ...r };
        if (t === 'guests') { assert.equal(r.source, null); delete o.source; }
        if (t === 'guests' || t === 'users') { assert.equal(r.bank_gems, 0); delete o.bank_gems; }
        if (t === 'users') for (const k of ['equip_sidekick', 'equip_sd_skin', 'equip_sd_name', 'sidekick_name', 'sidekick_color']) { assert.equal(r[k], null); delete o[k]; }
        if (t === 'shop_rotations') { delete o.sidekicks; }
        if (t === 'users' || t === 'guests') { for (const k of ['xp', 'level', 'xp_day', 'xp_day_n', 'xp_to']) { if (k in o) assert.equal(o[k], k === 'level' ? 1 : k === 'xp_to' ? null : 0); delete o[k]; } }
        return o;
    });
    for (const t of tables) assert.deepEqual(strip(t, db.all(`SELECT * FROM "${t}"`)), before[t], t + ' unchanged');
    assert.ok(db.get("SELECT 1 AS x FROM sqlite_master WHERE type = 'index' AND name = 'deaths_at'"));
    assert.throws(() => db.run("INSERT INTO deaths (at, cause) VALUES (1, 'lava')"), /CHECK/);
    db.run("INSERT INTO deaths (at, user_id, cause, life_ms) VALUES (1, 1, 'bot', 5)");
    assert.equal(db.get('PRAGMA integrity_check').integrity_check, 'ok');
    assert.equal(db.get('PRAGMA foreign_key_check'), null);
    // a second run is a no-op
    assert.deepEqual(migrations.apply(db).applied, []);
    db.close();
});

test('guests: the first known source sticks, junk is dropped', () => {
    const guests = require(path.join(SERVER, 'accounts', 'guests'));
    const a = 'a'.repeat(32), b = 'b'.repeat(32), c = 'c'.repeat(32);
    guests.seen(a, 1000);
    guests.seen(a, 2000, 'embed:iogames.space');
    guests.seen(a, 3000, 'itch.io');
    guests.seen(b, 1000, 'https://evil.example/?x=1');
    guests.seen(c, 1000, 'direct');
    const row = id => d.get('SELECT source, visits FROM guests WHERE guest_id = ?', id);
    assert.deepEqual({ ...row(a) }, { source: 'embed:iogames.space', visits: 3 });
    assert.equal(row(b).source, null);
    assert.equal(row(c).source, 'direct');
    assert.equal(guests.cleanSource('Embed:X'), null);
    assert.equal(guests.cleanSource('x'.repeat(49)), null);
    const commands = require(path.join(SERVER, 'accounts', 'discord', 'commands'));
    assert.ok(typeof commands.sourcesText === 'function');
    assert.match(commands.sourcesText(d, 0), /iogames\.space 1 \(1 embed\)/);
});

let failed = 0;
for (const t of tests) {
    try { t.fn(); console.log('ok   ' + t.name); }
    catch (e) { failed++; console.log('FAIL ' + t.name + '\n     ' + (e && e.stack || e)); }
}
try { d.close(); } catch { /* */ }
if (!failed) { try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* */ } }
console.log(failed ? `${failed} of ${tests.length} failed` : `all ${tests.length} passed`);
process.exit(failed ? 1 : 0);
