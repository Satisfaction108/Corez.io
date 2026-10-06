// Round 10 server rules (Oct 2026 blind playtest, 62/100): node scripts/test/round10.test.js
//
//   leader    the board's #1 carries a standing bounty (10% of the lead over
//             #2, min 150, cap 2,500), paid by the raid to whoever takes them
//             down, bots included; the leader loses nothing extra
//   late      kill points step up with the storm stage like gems (x1/x1.5/x2)
//   banking   at least 1,200 gems/s and never over 3 s (8,098 banks in ~3 s)
//   pack      any bot that killed you in the last 3 min leaves you be for the
//             first 60 s of your next life (fight back still works) and the
//             respawn keeps clear of all of them
//   bosses    stay 400 past a vault's rim (roam, chase, spawn pit)
//   carry     a new raid starts on the plain starting satchel (no place bonus)
'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.join(__dirname, '..', '..');
const SERVER = path.join(REPO, 'server');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-round10-test-'));
process.env.DATA_DIR = path.join(ROOT, 'data');
for (const k of ['ROYALE_DEBUG', 'ROYALE_LEADER_BOUNTY', 'ROYALE_STAGE_KILLS', 'ROYALE_BANK_RATE', 'ROYALE_BANK_MAX_S',
    'ROYALE_FAIR_PACK', 'ROYALE_FAIR_BOTS', 'ROYALE_FAIR_PLAY', 'ROYALE_BOSS_VAULT_CLEAR', 'ROYALE_PLACE_BONUS', 'ROYALE_FAIR_HIT25']) delete process.env[k];
process.env.NODE_ENV = 'test';

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
global.gameManager.gameHandler = new gameHandler(global.gameManager);

const T = p => require(path.join(SERVER, 'game', 'terrain', p));
const royale = require(path.join(SERVER, 'game', 'gamemodes', 'scripts', 'dig_royale.js'));
const fair = T('fairPlay.js');
const vault = T('vault.js');
const bosses = T('bosses.js');
const storm = T('storm.js');
const pacing = T('pacing.js');
const contracts = T('contracts.js');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');
const live = (o) => Object.assign({ isDead: () => false }, o);

test('leader bounty: 10% of the lead over #2, min 150, cap 2,500, only for a real lead', () => {
    const f = pacing.leaderBountyFor;
    assert.equal(f(999, 5000), 0, 'under a 1,000 lead: none');
    assert.equal(f(1000, 5000), 150, 'min 150');
    assert.equal(f(4000, 9000), 400);
    assert.equal(f(4720, 12818), 470, 'the playtest raid (12,818 vs ~8,100)');
    assert.equal(f(40_000, 50_000), 2500, 'cap');
    assert.equal(f(1400, 1400), 0, 'a 1,400-point raid is too early');
});

test('leader bounty: marks the leader, pays any killer (bots too), the leader loses nothing', () => {
    const said = [], paid = [], calls = [];
    const leader = live({ id: 11, name: 'Leader', team: 1, x: 0, y: 0, carriedGems: 0 });
    const killer = live({ id: 12, name: 'BotKiller', team: 2, isBot: true });
    let L = { body: leader, key: 'k1', score: 12_000, lead: 6000 };
    pacing.attach({
        live: () => true, humans: () => [], fighters: () => [leader, killer], keyOf: b => 'k' + b.id,
        leader: () => L,
        announce: (text, feed) => said.push({ text, feed }),
        callout: (...a) => calls.push(a),
        pay: () => assert.fail('a bot killer is paid through payAny'),
        payAny: (b, n, why) => paid.push({ b, n, why }),
    });
    pacing.reset(1000);
    pacing.tick(10_000);
    const snap = pacing.snapshot(10_000);
    assert.ok(snap && snap.e === 11 && snap.lead === 1 && snap.gems === 600 && snap.ms === 0, JSON.stringify(snap));
    assert.equal(said.length, 1);
    assert.match(said[0].text, /^Bounty on the leader: Leader\. 600 gems/);
    assert.ok(!/—/.test(said[0].text), 'no em dash');
    // the lead grows: same holder, bigger price, no second announcement
    L = { body: leader, key: 'k1', score: 14_000, lead: 8000 };
    pacing.tick(11_500);
    assert.equal(pacing.current().gems, 800);
    assert.equal(said.length, 1);
    // a bot victim's share is honoured (mult), a teammate gets nothing
    const mate = live({ id: 13, team: 1, isBot: true });
    assert.equal(pacing.onKill(mate, leader, 1), 0, 'same team: nothing');
    pacing.tick(13_000);
    const got = pacing.onKill(killer, leader, 1);
    assert.equal(got, 800);
    assert.equal(paid.length, 1);
    assert.ok(paid[0].b === killer && paid[0].n === 800 && paid[0].why === 'leaderBounty');
    assert.equal(leader.carriedGems, 0, 'nothing taken from the leader');
    assert.equal(pacing.current(), null, 'cleared until the next tick');
    // a lead under the line: no bounty at all
    L = { body: leader, key: 'k1', score: 3000, lead: 500 };
    pacing.tick(20_000);
    assert.equal(pacing.current(), null);
    // dig_royale wiring: the pay-anyone hook and the bot share
    const src = read('server/game/gamemodes/scripts/dig_royale.js');
    assert.ok(/pacing\.onKill\(killerBody, body, vk\)/.test(src));
    assert.ok(/payAny: \(body, n, why\) => payAny\(body, n, why\)/.test(src) && /leader: \(\) => leaderInfo\(\)/.test(src));
    // the claim contract never carries an infinite clock
    assert.ok(/Math\.min\(b\.until - t, 120_000\)/.test(read('server/game/terrain/contracts.js')));
    pacing.reset();
});

test('leader bounty: a bot killer is credited on its own bank and board row', () => {
    const bot = live({ id: 501, isBot: true, name: 'Rowbot', team: 77, botBanked: 100, carriedGems: 0, x: 0, y: 0 });
    royale._payAny(bot, 600, 'leaderBounty');
    assert.equal(bot.botBanked, 700);
    const s = royale._statOf(bot);
    assert.ok(s && (s.banked | 0) === 600, 'board row: ' + (s && s.banked));
});

test('late raid: kill points use the storm stage multiplier (x1 / x1.5 / x2)', () => {
    assert.equal(royale.killStageMult(), storm.gemStageMult());
    const src = read('server/game/gamemodes/scripts/dig_royale.js');
    assert.ok(/const kp0 = Math\.round\(\(victimBot \? botKillScore\(\) : killScore\(\)\) \* killStageMult\(\)\);/.test(src));
    assert.deepEqual(storm.GEM_STAGE, [1, 1.5, 2]);
});

test('banking: at least 1,200 gems/s, and any deposit done in 3 s', () => {
    assert.equal(vault.DEPOSIT_RATE, 1200);
    assert.equal(vault.BANK_MAX_S, 3);
    assert.equal(vault.depositRate(100), 1200, 'small deposits at the floor rate');
    const r = vault.depositRate(8098);
    assert.ok(Math.abs(8098 / r - 3) < 1e-9, '8,098 in 3 s, not 27 s');
    assert.ok(8098 / 300 > 26, 'the old pace was 27 s');
    // bases bank at the same pace (outposts.js asks vault.js)
    assert.ok(/require\('\.\/vault\.js'\)\.depositRate\(d\.total \/ EFFICIENCY\)/.test(read('server/game/terrain/outposts.js')));
    // damage still cuts a deposit
    assert.ok(/body\.health\.amount < d\.lastHealth - 1e-3 && !body\._inStorm\) \{\s*cancelDeposit\(body\)/.test(read('server/game/terrain/vault.js')));
});

test('pack rule: any bot that killed you lately holds off for 60 s of your next life', () => {
    const t = Date.now();
    const bot = { id: 900, isBot: true, botFamilyId: 900, health: { max: 400, amount: 400 }, _dmgBy: new Map() };
    const socket = { id: 77 };
    const me = { id: 78, isPlayer: true, socket, royaleBornAt: t - 10_000 };
    socket.player = { body: me };
    fair.noteKilledBy(socket, bot, t - 30_000, 1);
    assert.equal(fair.farmed(bot, me, t), true, 'one kill is enough now (was 2)');
    assert.equal(fair.farmed(bot, me, t + 51_000), false, '60 s into the life: fair game again');
    // shooting it (25% of its health) lets it fight back
    bot._dmgBy.set(me.id, 100); bot._lastDamageSource = me; bot._lastDamageAt = t;
    assert.equal(fair.farmed(bot, me, t), false, 'fight back allowed');
    bot._dmgBy.clear(); bot._lastDamageSource = null;
    // a kill over 3 min old doesn't count
    const old = { id: 79, isPlayer: true, socket: { id: 80 }, royaleBornAt: t - 5000 };
    fair.noteKilledBy(old.socket, bot, t - 200_000, 1);
    assert.equal(fair.farmed(bot, old, t), false);
    // bots only: a human killer is never held back by it
    const human = { id: 81, isPlayer: true, socket: { id: 82 } };
    fair.noteKilledBy(socket, human, t - 20_000, 1);
    assert.equal(fair.farmed(human, me, t), false);
    // the respawn keeps clear of every one of them (live bodies)
    const liveBot = live(Object.assign({}, bot, { x: 0, y: 0 }));
    const farm = fair.farmersOf(me, [liveBot], t);
    assert.equal(farm.length, 1, 'one kill puts it on the keep-away list');
    assert.equal(fair.TUNE.PACK_MS, 180_000);
    assert.equal(fair.TUNE.PACK_GRACE_MS, 60_000);
});

test('bosses: no loitering within 400 of a vault (roam, chase, spawn)', () => {
    const vs = [{ x: 0, y: 0, r: 95 }];
    const ring = 95 * 1.4 + 400;
    assert.equal(bosses.VAULT_CLEAR, 400);
    assert.ok(bosses.nearVault(200, 0, vs), 'by the vault');
    assert.equal(bosses.nearVault(ring + 5, 0, vs), null, 'past the ring');
    const p = bosses.clearOfVaults({ x: 30, y: 40 }, vs);
    assert.ok(Math.hypot(p.x, p.y) >= ring, 'pushed out: ' + Math.hypot(p.x, p.y));
    assert.ok(Math.abs(Math.atan2(p.y, p.x) - Math.atan2(40, 30)) < 1e-6, 'straight out');
    const c = read('server/miscFiles/controllers.js');
    assert.ok(/bossMod\.nearVault\(x, y\)\) continue;/.test(c), 'roam points');
    assert.ok(/if \(bm && !body\.bossHome\) dest = bm\.clearOfVaults\(dest\);/.test(c), 'chase spots');
    assert.ok(/const offVault = inCircle\.filter\(p => !nearVault\(p\.x, p\.y\)\);/.test(read('server/game/terrain/bosses.js')), 'spawn pits');
});

test('new raid: the plain starting satchel, no carry-over from the last raid', () => {
    assert.equal(royale.PLACE_BONUS, false);
    const src = read('server/game/gamemodes/scripts/dig_royale.js');
    assert.ok(/if \(PLACE_BONUS\) client\.raidBonus = /.test(src), 'placement bonus gated');
    assert.ok(/body\.carriedGems = isRespawn \|\| noStarter \? Math\.max\(body\.carriedGems \| 0, grant\) : grant;/.test(src), 'fresh start is exact');
    // a kept share only comes back inside the raid it was kept in
    assert.ok(/const same = \(body\.socket\._carryKeepRaid \| 0\) === raidId;/.test(src));
    // the raid-end death keeps nothing, and bots restart from a fresh roster
    const g = T('gems.js');
    assert.equal(g.carryKeepFor({ deathCause: 'raidend' }, 1000), 0);
    assert.ok(/why === 'raidend'\) return false;/.test(read('server/game/terrain/botRoster.js')));
    assert.ok(/botRoster\.resetRaid\(\)/.test(src));
});

(async () => {
    let failed = 0;
    for (const t of tests) {
        try { await t.fn(); log('ok   ' + t.name); }
        catch (e) { failed++; log('FAIL ' + t.name + '\n     ' + ((e && e.stack) || e).toString().split('\n').slice(0, 8).join('\n     ')); }
    }
    log(`\n${tests.length - failed}/${tests.length} passed`);
    try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* */ }
    process.exit(failed ? 1 : 0);
})();
