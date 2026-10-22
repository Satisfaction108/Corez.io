// Round 9 server rules: node scripts/test/round9.test.js
//
//   bots      a protected player is ignored until they've dealt 25% of the
//             bot's max health; bots prefer targets near their own size;
//             bot growth and points slow down past a threshold (no cap)
//   shields   quick death -> 8 s shield that holds while moving and ends on
//             a shot; a finished deposit -> 3 s shield when you leave
//   bosses    pushed off vault/shop pads, their bullets die on a pad
//   pace      gem value x1 / x1.5 / x2 by storm stage, 15 s between
//             contracts, revenge doubled
//   mining    ore chips per hit come out of the break payout (same total)
//   bugs      solo colour survives a reconnect, crown risk is one stable number
'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.join(__dirname, '..', '..');
const SERVER = path.join(REPO, 'server');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-round9-test-'));
process.env.DATA_DIR = path.join(ROOT, 'data');
for (const k of ['ROYALE_DEBUG', 'ROYALE_FAIR_HIT25', 'ROYALE_BOT_SIZE_PREF', 'ROYALE_BOT_DIM', 'ROYALE_MINE_CHIPS',
    'ROYALE_STAGE_GEMS', 'ROYALE_BOSS_PADS', 'ROYALE_BANK_SHIELD', 'ROYALE_QUICK_SHIELD', 'ROYALE_CONTRACT_GAP_MS']) delete process.env[k];
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
const controllers = require(path.join(SERVER, 'miscFiles', 'controllers.js'));
const fair = T('fairPlay.js');
const growth = T('growth.js');
const vault = T('vault.js');
const bosses = T('bosses.js');
const gems = T('gems.js');
const storm = T('storm.js');
const contracts = T('contracts.js');
const soloColor = T('soloColor.js');
const crowns = T('crowns.js');
const { ORE } = T('terrainGrid.js');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');

test('25% rule: a protected player is fought only after dealing a quarter of the bot\'s max health', () => {
    const bot = { id: 1, isBot: true, health: { max: 400, amount: 400 }, _dmgBy: new Map() };
    const p = { id: 2, isPlayer: true };
    const t = Date.now();
    // one shot used to be enough
    bot._lastDamageSource = p; bot._lastDamageAt = t;
    bot._dmgBy.set(p.id, 20);
    assert.equal(fair.hitBy(bot, p, t), false, 'one shot: still ignored');
    bot._dmgBy.set(p.id, 99);
    assert.equal(fair.provoked(bot, p), false, 'just under 25%');
    bot._dmgBy.set(p.id, 100);
    assert.equal(fair.hitBy(bot, p, t), true, '25%: fights back');
    // past it, the usual fight-back window from each hit
    assert.equal(fair.provoked(bot, p), true, 'still provoked later');
    assert.equal(fair.hitBy(bot, p, t + 60_000), false, 'no hits for a minute: lets them be');
    assert.equal(fair.TUNE.PROVOKE_SHARE, 0.25);
    // the damage is booked per attacker in index.js from the damage amount
    const ix = read('server/game/index.js');
    assert.ok(/o\._dmgBy \|\| \(o\._dmgBy = new Map\(\)\)/.test(ix) && /amount: this\.damageReceived/.test(read('server/game/entities/entity.js')));
    // softSpared uses it too
    assert.ok(/fairPlay\.on\('hit25'\) \|\| fairPlay\.provoked\(bot, target\)/.test(read('server/miscFiles/controllers.js')));
});

test('size preference: targets over 2x or under 0.5x the bot\'s points rank lower, still attackable', () => {
    const bot = { isBot: true, _fpPts: 1000 };
    assert.equal(controllers.sizePenalty(bot, { _fpPts: 1500 }), 0, 'near our size');
    assert.equal(controllers.sizePenalty(bot, { _fpPts: 600 }), 0);
    assert.ok(controllers.sizePenalty(bot, { _fpPts: 2500 }) > 0, 'much bigger');
    assert.ok(controllers.sizePenalty(bot, { _fpPts: 300 }) > 0, 'much smaller');
    assert.ok(controllers.sizePenalty(bot, { _fpPts: 300 }) < 1000, 'a penalty, not a ban');
    assert.equal(controllers.sizePenalty({ isPlayer: true, _fpPts: 1000 }, { _fpPts: 9000 }), 0, 'bots only');
    // early raid: everyone near 0 counts as the same size
    assert.equal(controllers.sizePenalty({ isBot: true, _fpPts: 0 }, { _fpPts: 120 }), 0);
});

test('bot diminishing returns: growth and points slow past a threshold, never capped', () => {
    const at = growth.BOT_DIM_AT;
    assert.equal(growth.botDimAdd(at - 1, 100), 100, 'full rate below');
    assert.equal(growth.botDimAdd(at * 2, 100), 50, 'half rate at 2x');
    assert.ok(growth.botDimAdd(at * 10, 100) > 0, 'never zero');
    const d = royale.botDimScore;
    assert.equal(d(1000), 1000);
    assert.ok(d(5000) < 5000 && d(5000) > 2500);
    assert.ok(d(50_000) > d(20_000) && d(20_000) > d(10_000), 'still grows');
});

test('quick death: an 8 s shield that holds while moving and ends on a shot', () => {
    const t = Date.now();
    assert.equal(royale.quickDeath({ _r9LifeAt: t - 20_000, lastRaidDeathAt: t - 1000 }), true, '19 s life');
    assert.equal(royale.quickDeath({ _r9LifeAt: t - 60_000, lastRaidDeathAt: t - 1000 }), false, '59 s life');
    assert.equal(royale.quickDeath({ _r9LifeAt: t, lastRaidDeathAt: t - 1000 }), false, 'alive now');
    const body = { invuln: false, settings: {}, control: { target: { x: 1, y: 0 } } };
    const player = { command: {}, target: { x: 1, y: 0 }, body };
    const io = new controllers.ioTypes.listenToPlayer(body, { player });
    assert.ok(vault.grantTimedShield(body, 8000, Date.now()));
    assert.ok(body.invuln && body.shieldEndAt - Date.now() > 7900);
    io.think();
    player.command.up = true; player.command.right = true;
    io.think(); io.think();
    assert.equal(body.invuln, true, 'moving keeps it');
    player.command.lmb = true;
    io.think();
    assert.equal(body.invuln, false, 'a shot ends it');
    // and it ends on time
    vault.grantTimedShield(body, 8000, Date.now());
    player.command.lmb = false; io.think();
    body.shieldEndAt = Date.now() - 1;
    io.think();
    assert.equal(body.invuln, false, 'over after 8 s');
    assert.ok(/quickDeath\(sock\) && vault\.grantTimedShield\(body, QUICK_SHIELD_MS, now\(\)\)\) body\.shieldSoftEnd = true/.test(read('server/game/gamemodes/scripts/dig_royale.js')));
    vault.grantTimedShield(body, 8000, Date.now());
    body.shieldSoftEnd = true;
    player.command.up = false; player.command.right = false; player.command.lmb = false;
    io.think();
    body.shieldEndAt = body.spawnGraceUntil = Date.now() - 1;
    io.think();
    assert.equal(body.invuln, true, 'a respawn shield turns into the normal one at 8 s while you stand still');
    player.command.up = true;
    io.think();
    assert.equal(body.invuln, false, 'and moving then ends it');
});

test('post-bank: banking during a visit gives a 3 s vault shield on every exit', () => {
    assert.equal(vault.POST_BANK_SHIELD_MS, 3000);
    const src = read('server/game/terrain/vault.js');
    assert.ok(/body\._bankedVisit = true;/.test(src) && /grantTimedShield\(body, POST_BANK_SHIELD_MS, now\)/.test(src));
    assert.ok(/talk\('VU', 2\)/.test(src), 'the client hears it is a vault shield');
    assert.ok(/function vaultShieldNow\(\)/.test(read('public/client/app.js')), 'the vault shield ring is told apart');
    const body = { invuln: false };
    const t = Date.now();
    vault.grantTimedShield(body, vault.POST_BANK_SHIELD_MS, t);
    assert.equal(body.shieldEndAt, t + 3000);
    assert.equal(body.shootEndsShield, true);
});

test('bosses: pushed off vault and shop pads, their bullets die on a pad', () => {
    const pads = [{ x: 0, y: 0, r: 95 }, { kind: 'shop', x: 2000, y: 0, r: 95 }];
    const boss = { x: 60, y: 0, realSize: 80, velocity: { x: -3, y: 0 }, accel: { x: 0, y: 0 } };
    bosses.tickPads(boss, pads);
    assert.ok(boss.velocity.x > -3 || boss.accel.x > 0 || boss.x > 60, 'pushed outward');
    for (let i = 0; i < 40; i++) { boss.x += boss.velocity.x; boss.y += boss.velocity.y; boss.velocity.x += boss.accel.x; boss.accel.x = 0; bosses.tickPads(boss, pads); }
    assert.ok(boss.x > 60, 'out at the rim: ' + boss.x);
    const mk = (x, y) => ({ x, y, size: 6, velocity: { x: 5, y: 0 }, accel: { x: 0, y: 0 }, dead: false, kill() { this.dead = true; }, isDead() { return this.dead; } });
    const onShop = mk(2010, 5), away = mk(900, 900);
    bosses._shots.length = 0;
    bosses._shots.push(onShop, away);
    const killed = bosses.tickPads(boss, pads);
    assert.equal(killed, 1);
    assert.ok(onShop.dead && onShop.velocity.x === 0, 'dies still, no fling');
    assert.ok(!away.dead);
});

test('stage gem multiplier: x1 / x1.5 / x2, in the storm snapshot as gmul', () => {
    assert.deepEqual(storm.GEM_STAGE, [1, 1.5, 2]);
    assert.ok('gmul' in storm.snapshot());
    const orig = storm.gemStageMult;
    const rock = { ore: ORE.VEIN, soft: true };
    try {
        storm.gemStageMult = () => 1; const a = gems.depositValue(rock, {}, null);
        storm.gemStageMult = () => 1.5; const b = gems.depositValue(rock, {}, null);
        storm.gemStageMult = () => 2; const c = gems.depositValue(rock, {}, null);
        assert.equal(b, Math.round(a * 1.5));
        assert.equal(c, a * 2);
    } finally { storm.gemStageMult = orig; }
});

test('mining chips: paid per hit out of the break payout, same total per rock; plain rock pays none', () => {
    const fx = [];
    const owner = { id: 77, socket: { talk: (...a) => fx.push(a) }, carriedGems: 0, gemCap: 8000 };
    const mkRock = () => ({ ore: ORE.SHARD, soft: true, maxHealth: 300, health: 300, alive: true, wx: 0, wy: 0,
        deposits: [{ wx: 0, wy: 0, wr: 9 }, { wx: 10, wy: 0, wr: 9 }, { wx: 0, wy: 10, wr: 9 }] });
    const spawned = [];
    const E = global.Entity, P = global.Prop;
    global.Entity = class { constructor(p) { this.x = p.x; this.y = p.y; this.velocity = { x: 0, y: 0 }; spawned.push(this); } define() {} refreshBodyAttributes() {} };
    global.Prop = class { define() {} };
    try {
        const r0 = mkRock();
        const total = gems.payoutOf(r0, owner);
        gems.spawnOreBurst(r0, null);
        const plain = spawned.reduce((n, g) => n + g.gemValue, 0);
        assert.equal(plain, total, 'no chips: the whole payout at the break');
        spawned.length = 0;
        const r = mkRock();
        let chips = 0;
        for (let i = 0; i < 9; i++) chips += gems.chipHit(r, owner, 30, 0, 0, false);
        assert.ok(chips > 0 && chips <= Math.floor(total * gems.CHIP_SHARE), 'chips: ' + chips);
        assert.equal(owner.carriedGems, chips);
        gems.spawnOreBurst(r, owner);
        const burst = spawned.reduce((n, g) => n + g.gemValue, 0);
        assert.equal(chips + burst, total, 'same total per rock');
        assert.ok(spawned.every(g => g.gemPullUntil > Date.now()), 'they fly to the breaker');
        const ev = fx.filter(a => a[0] === 'FX' && a[3] === 'mchip');
        assert.ok(ev.length > 0 && ev.every(a => a.length === 6 && a[4] === ORE.SHARD), 'mchip x, y, ore, n');
        // plain rock: dust only, throttled
        fx.length = 0; owner.carriedGems = 0; owner._dustFxAt = 0;
        const pr = { ore: 0, maxHealth: 100, health: 100, alive: true };
        for (let i = 0; i < 5; i++) assert.equal(gems.chipHit(pr, owner, 10, 1, 2, false), 0);
        const dust = fx.filter(a => a[3] === 'mchip');
        assert.equal(dust.length, 1, 'throttled to 8/s');
        assert.deepEqual(dust[0].slice(4), [0, 0]);
    } finally { global.Entity = E; global.Prop = P; }
    assert.ok(gems.PLAIN_ROCK_MULT >= 1.25 && gems.PLAIN_ROCK_MULT <= 1.45, 'plain rock ~30% faster');
});

test('contracts: 15 s between jobs, revenge doubled; mining combo capped at +25%', () => {
    assert.equal(contracts.COOLDOWN_MS, 15_000);
    assert.equal(contracts.REVENGE_GEMS, 400);
    assert.equal(contracts.REVENGE_PTS, 400);
    assert.equal(gems.COMBO_STEP, 0.1);
    assert.equal(gems.COMBO_CAP, 0.25);
});

test('solo colour: survives a reconnect (keyed by guest/account, not socket)', () => {
    let n = 0;
    const prev = global.assignTeamColor;
    global.assignTeamColor = () => 30 + (n++);
    try {
        const a = soloColor.colorFor({ guestId: 'gx9' }, -101, 42, null);
        const b = soloColor.colorFor({ guestId: 'gx9' }, -102, 42, null);
        assert.equal(b, a, 'new socket, same guest: same colour');
        const c = soloColor.colorFor({ account: { id: 5 } }, -103, 42, null);
        assert.equal(soloColor.colorFor({ account: { id: 5 } }, -104, 42, null), c);
        assert.notEqual(soloColor.colorFor({ guestId: 'gx9' }, -105, 43, null), undefined);
    } finally { global.assignTeamColor = prev; }
});

test('crown risk: one number from the steal formula, moves only with the points', () => {
    let risk = 1000;
    crowns.attach({ scoreOf: () => risk, riskOf: () => risk });
    const b = { id: 9 };
    const n = crowns.stealOf(b);
    assert.equal(n, crowns.stealFor(1000));
    assert.equal(crowns.stealOf(b), n, 'stable');
    assert.ok(crowns.riskText(b).includes(String(n)), crowns.riskText(b));
    risk = 1500;
    assert.equal(crowns.stealOf(b), crowns.stealFor(1500), 'follows the points');
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

test('round 10: a Team Bank goes to the most damage, ties to the last hitter', () => {
    const outposts = T('outposts.js');
    const a = { id: 9001, team: -9001, name: 'A', isPlayer: true }, b = { id: 9002, team: -9002, name: 'B', isPlayer: true };
    const site = {};
    outposts.creditDamage(site, a, 99);
    outposts.creditDamage(site, b, 1);
    site._lastHitter = b;
    assert.equal(outposts.killerOf({ finalKillers: [b] }, site), a, '99% beats the last 1 HP');
    const tie = {};
    outposts.creditDamage(tie, a, 5);
    outposts.creditDamage(tie, b, 5);
    tie._lastHitter = b;
    assert.equal(outposts.killerOf(null, tie), b, 'a tie goes to the last hitter');
    // a duo's damage adds up; the base goes to its top dealer
    const c = { id: 9003, team: -9001, name: 'C' }, d = { id: 9004, team: -9004, name: 'D' };
    const duo = {};
    outposts.creditDamage(duo, a, 30); outposts.creditDamage(duo, c, 30); outposts.creditDamage(duo, d, 50);
    duo._lastHitter = d;
    assert.ok([a, c].includes(outposts.killerOf(null, duo)), 'team 60 beats a solo 50');
    assert.equal(outposts.killerOf({ finalKillers: [b] }, {}), b, 'no damage record: the old killer rule');
});

test('round 10: every projectile dies on a vault or shop pad, the Core\'s bolts and drones too', () => {
    const idx = read('server/game/index.js');
    assert.ok(/shop\.getShops\(\)[\s\S]{0,400}padGeom\.insidePad\(sp, instance\.x, instance\.y, 8\)[\s\S]{0,200}instance\.kill\(\)/.test(idx), 'shop pads kill projectiles in the main loop');
    const core = T('coreFinale.js'), vaultM = T('vault.js'), shopM = T('shop.js');
    const gv = vaultM.getVaults, gs = shopM.getShops;
    try {
        vaultM.getVaults = () => [{ x: 0, y: 0, r: 95, rainbow: true }];
        shopM.getShops = () => [{ kind: 'shop', x: 3000, y: 0, r: 95 }];
        assert.equal(core.onSafePad(10, 10), true, 'on the vault');
        assert.equal(core.onSafePad(3020, 0), true, 'on the shop');
        assert.equal(core.onSafePad(1500, 1500), false, 'open ground');
    } finally { vaultM.getVaults = gv; shopM.getShops = gs; }
    // Oct 6: no shard volleys; bolts and drones check the pads themselves
    assert.equal(core.SHARD_ATTACK, false);
    const cf = read('server/game/terrain/coreFinale.js');
    assert.ok(/if \(onAnyPad\(padList, e\.x, e\.y, BOLT_RADIUS\)\) \{ dead = true; break; \}/.test(cf), 'bolts die on pads');
    assert.ok(/if \(!dead && onAnyPad\(padList, e\.x, e\.y, 0\)\) dead = true;/.test(cf) && cf.includes("padGeom.keepOut(e, p, 6, 'core:'"), 'drones die on pads and are held out');
});

// ── Oct 5 2026: "dying feels like a tax" (the same rules for everyone) ──
const bankM = T('bank.js');
const botRosterM = T('botRoster.js');
const nxM = T('newcomerDirector.js');
const botDiffM = require(path.join(SERVER, 'miscFiles', 'botDifficulty.js'));
const miningM = T('mining.js');
let deathIds = 70000;
function deathBody({ bot = false, carried = 0, banked = 0, kept = 0 } = {}) {
    const t = new Entity({ x: 4000 + (deathIds % 50) * 30, y: 4000 });
    t.define('basic');
    t.alwaysActive = true;
    t.team = -1 - (deathIds++ & 0xff);
    t.deathCause = 'bot';
    if (bot) { t.isBot = true; t.botFamilyId = 'fam' + deathIds; t.name = 'Bot' + deathIds; }
    else {
        const s = { id: deathIds++, packets: [], status: {}, camera: { x: 0, y: 0 }, gemBanked: banked, bankKept: kept, _bankOut: true };
        s.talk = (...a) => s.packets.push(a);
        t.isPlayer = true; t.socket = s; s.player = { body: t };
        t.nxStage = 3;          // not a first raid (that rule is checked below)
    }
    gems.initSatchel(t);
    t.carriedGems = carried;
    return t;
}
const msgs = s => s.packets.filter(a => a[0] === 'm').map(a => String(a[2])).join(' | ');

test('rule 1: banked gems are 100% safe on death by default (env brings the savings tax back)', () => {
    assert.equal(bankM.deathLossEnabled(), false, 'off unless ROYALE_SAVINGS_DEATH_LOSS=1');
    const p = deathBody({ banked: 5000, kept: 5000, carried: 0 });
    assert.equal(bankM.deathLossFor(p), 0);
    gems.dropGemsOnDeath(p, []);
    assert.equal(p.socket.gemBanked, 5000, 'savings untouched');
    assert.equal(p.socket.gemDeathBankLoss, 0);
    assert.ok(!/savings/.test(msgs(p.socket)), 'no "Dying cost N of your savings" message');
    bankM.setDeathLoss(true);
    try { assert.equal(bankM.deathLossFor(deathBody({ banked: 5000, kept: 5000 })), 500, 'the old 10% when switched on'); }
    finally { bankM.setDeathLoss(false); }
    assert.ok(/ROYALE_SAVINGS_DEATH_LOSS === '1'/.test(read('server/game/terrain/bank.js')));
});

test('rule 2: everyone keeps 30% of the satchel through a death, 70% drops as loot', async () => {
    assert.equal(gems.CARRY_KEEP, 0.3);
    const p = deathBody({ carried: 1000 });
    gems.dropGemsOnDeath(p, []);
    assert.equal(p.socket.gemDeathKept, 300, 'kept 30%');
    assert.equal(p.socket.gemDeathCarried, 700, 'dropped 70%');
    assert.equal(p.socket._carryKeep, 300, 'comes back on the respawn');
    assert.equal(gems.carryKeepFor(p, 333), 100, 'rounded');
    // bots too: the share rides on the roster entry of the same bot coming back
    const b = deathBody({ bot: true, carried: 1000 });
    botRosterM.onBotGone(b, Date.now(), 'bot');
    gems.dropGemsOnDeath(b, []);
    const w = botRosterM._waiting.find(e => e.familyId === b.botFamilyId);
    assert.ok(w && w.carry === 300, 'a bot keeps the same 30%');
    botRosterM.resetRaid();
    // the raid ending or leaving keeps nothing
    const q = deathBody({ carried: 1000 }); q.deathCause = 'raidend';
    assert.equal(gems.carryKeepFor(q, 1000), 0);
    // a first death's half and the 30% never stack: the larger one
    const orig = nxM.keepOnDeath;
    try {
        nxM.keepOnDeath = (body, c) => Math.floor(c * 0.5);
        const n = deathBody({ carried: 1000 });
        gems.dropGemsOnDeath(n, []);
        assert.equal(n.socket.gemDeathKept, 500, 'half, not half + 30%');
        assert.equal(n.socket._carryKeep, 0, 'the newcomer half is restored by newcomerDirector only');
        nxM.keepOnDeath = (body, c) => Math.floor(c * 0.1);
        const m = deathBody({ carried: 1000 });
        gems.dropGemsOnDeath(m, []);
        assert.equal(m.socket.gemDeathKept, 300, 'max(10%, 30%)');
        assert.equal(m.socket._carryKeep, 200, 'only the part past the other rule');
    } finally { nxM.keepOnDeath = orig; }
    // respawn gives it back (dig_royale giveStarterKit), the death card says it
    const dr = read('server/game/gamemodes/scripts/dig_royale.js');
    assert.ok(/body\.socket\._carryKeep \| 0/.test(dr) && /back\.carry \| 0/.test(dr));
    const SL = await import(path.join(REPO, 'public', 'client', 'scoreLogic.js'));
    assert.equal(SL.deathLine({ pts: { b: 0, k: 0, c: 0 }, dl: { p: 0 } }, 700, 0, 300).sub,
        'You kept 300 carried gems and dropped 700. Bank sooner to keep them all.');
    assert.ok(/global\.finalNxKept \| 0/.test(read('public/client/app.js')) && /Kept /.test(read('public/client/app.js')), 'the death card says what you kept');
});

test('rule 3: bots are 20% gentler on every human and fight each other about half the time', () => {
    assert.equal(botDiffM.GENTLE_DEFAULT, 0.2);
    const g = botDiffM.gentle({ isPlayer: true });
    assert.equal(g, 0.2);
    assert.equal(botDiffM.gentle({ isBot: true }), 0, 'bot vs bot unchanged');
    assert.ok(Math.abs(botDiffM.gentleReact(g) - 1.2) < 1e-9, 'reactions 20% slower');
    assert.ok(Math.abs(botDiffM.gentleAimErr(g) - 1.2) < 1e-9, 'aim error x1.2');
    assert.ok(Math.abs(botDiffM.gentleStiff(g) - 0.85) < 1e-9, 'aim spring x0.85');
    assert.ok(Math.abs(botDiffM.gentleLead(g) - 0.9) < 1e-9, 'lead x0.9');
    assert.ok(Math.abs(botDiffM.gentleLock(g) - 0.8) < 1e-9, 'lock-on x0.8');
    assert.ok(Math.abs(botDiffM.gentleRange(g) - 0.9) < 1e-9, 'fights start 10% closer');
    assert.ok(Math.abs(botDiffM.gentlePenalty(g) - 100) < 1e-9, 'picked as if 100 farther');
    // the coin: about half of the spells prefer a bot
    assert.equal(botDiffM.PREFER_BOT, 0.5);
    let yes = 0;
    for (let i = 0; i < 2000; i++) { const io = {}; if (botDiffM.prefersBot(io, 0)) yes++; }
    assert.ok(yes > 850 && yes < 1150, 'about half: ' + yes);
    const io = {}; const first = botDiffM.prefersBot(io, 1000);
    assert.equal(botDiffM.prefersBot(io, 1000 + 4000), first, 'one spell lasts a few seconds');
    // wiring: only humans get it, player stats and shot damage untouched
    const c = read('server/miscFiles/controllers.js');
    assert.ok(/botDiff\.gentleReact\(botDiff\.gentle\(best(, now)?\)\)/.test(c), 'reaction');   // round 12: (best, now)
    assert.ok(/botDiff\.gentleLead\(gentle\)/.test(c) && /botDiff\.gentleLock\(gentle\)/.test(c), 'lead and lock');
    assert.ok(/root\.isPlayer && preferBot && root !== this\._lastEnemy \? botDiff\.PREFER_R : 0/.test(c), 'bot vs bot');
    assert.equal(botDiffM.shotMult(), 1, 'damage the same for everyone');
});

test('rule 4: everyone mines 35% faster bare, Mining Power still adds over a flatter curve', () => {
    const owner = pts => ({ skill: { raw: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, pts], caps: [] } });
    const sf = pts => miningM.skillFactor(owner(pts));
    assert.ok(Math.abs(sf(0) - 0.54) < 1e-9, 'bare 0.4 -> 0.54');
    assert.ok(Math.abs(sf(Config.skill_cap || 9) - 1.9) < 1e-9, 'full 2.0 -> 1.9');
    assert.ok(sf(4) > sf(0) && sf(9) > sf(4), 'points still add');
    // ramming: the same boost
    const ram = pts => { const o = owner(pts); o.skill.raw[6] = 9; o.guns = new Map([[1, {}]]); return miningM.grindSecondsFor(o); };
    assert.ok(Math.abs(ram(0) - 18.5 / 9 / 0.7425) < 1e-6, 'bare grind x1.35');
    assert.ok(Math.abs(ram(9) - 18.5 / 9 / 1.9) < 1e-6);
    // a sidekick digs like a bare Pounder on the new base
    assert.ok(Math.abs(T('sidekickDig.js').POUNDER_REF - 0.1 * 4 * 0.54) < 1e-9);
});
