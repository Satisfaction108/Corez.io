// Banking at the vault: node scripts/test/banking.test.js
//
//   camp       the anti-camp kick never lands on someone with gems to bank
//              while they pick an amount: an empty-handed sitter goes after
//              20 s, anyone with a bankable satchel after 50 s (warned
//              first), protected or not (Oct 5 2026: limits doubled, the
//              re-entry wait halved to 2.5 s, 10 s after a cash out); a
//              deposit request, even a refused one, restarts the clock
//   auto       anyone on a vault banks everything they carry without
//              touching the panel, at the same rate, and a hit cuts it for
//              everyone (a protected player used to bank 2x and uncut)
//   numbers    one rule for the bank: gems banked this raid are safe, a
//              death only costs DEATH_SHARE of the savings brought in from
//              earlier raids (never a protected player's), the death card
//              gets the real balance after the death and the loss, the
//              message says what was taken
//   client     the panel says gems (never dust) and leads with Bank all;
//              the BANKED slam is the deposit itself, the milestone slam
//              leads with its bonus; the death card reads the real balance;
//              the coach never steps back on a death and a bank finishes the
//              mining step; the death card's banked tile is this raid's
//              banked points (scoreLogic.js), the same number the board adds
'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..', '..');
const SERVER = path.join(REPO, 'server');
const CLIENT = path.join(REPO, 'public', 'client');

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
    room: { width: 5460, height: 5460, topPlayerID: -1, isIn: () => false, getAt: () => null, isInNorm: () => true },
    views: [], minimap: [], roomSpeed: 1, runSpeed: 1, clients: [], terrainGrid: null,
    socketManager: { players: [], clients: [], broadcast() {} },
};
const handler = new gameHandler(global.gameManager);
global.gameManager.gameHandler = handler;
function loop(n = 1) { for (let i = 0; i < n; i++) handler.gameloop(); }

const mapGen = require(path.join(SERVER, 'game', 'terrain', 'mapGen.js'));
const grid = mapGen.generate({ cols: 13, rows: 13, tileWidth: 420, fullLattice: true });
grid.buildVoronoiColliders();
global.gameManager.terrainGrid = grid;
try { require(path.join(SERVER, 'game', 'terrain', 'royaleLayout.js')).carveMatchPois(grid); } catch { /* */ }

const royale = require(path.join(SERVER, 'game', 'gamemodes', 'scripts', 'dig_royale.js'));
const fair = require(path.join(SERVER, 'game', 'terrain', 'fairPlay.js'));
const vault = require(path.join(SERVER, 'game', 'terrain', 'vault.js'));
const bank = require(path.join(SERVER, 'game', 'terrain', 'bank.js'));
const gems = require(path.join(SERVER, 'game', 'terrain', 'gems.js'));
const MIN = 60_000;

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

let ids = 9000;
function level45(t) {
    while (t.skill.level < 45) { t.skill.score += t.skill.levelScore; t.skill.maintain(); }
    t.refreshBodyAttributes();
}
function fakeSocket(minutes = 0, extra = {}) {
    const s = { id: ids++, packets: [], status: {}, camera: { x: 0, y: 0 }, _careerLives: 3, _careerPlayMs: minutes * MIN, ...extra };
    s.talk = (...a) => s.packets.push(a);
    return s;
}
function player(socket, x, y) {
    const t = new Entity({ x, y });
    t.define('basic');
    t.isPlayer = true;
    t.team = -1 - (ids++ & 0xff);
    t.name = 'Banker' + ids;
    t.alwaysActive = true;
    t.socket = socket;
    socket.player = { body: t };
    t.said = [];
    t.sendMessage = (m) => t.said.push(String(m));
    level45(t);
    return t;
}
// minutes 0: brand new (protected); 120: a regular
function spawn(minutes, x, y) {
    const s = fakeSocket(minutes);
    const p = player(s, x, y);
    royale.freshRaidBody(p);
    s.lastInputAt = Date.now();       // not idle (idle players lose protection)
    return p;
}

royale.tick();
const V = vault.getVaults()[0];
assert.ok(V, 'the map has vaults');

// stand on the vault with a satchel; one tick so the pad registers
function onVault(p, carried) {
    p.x = V.x; p.y = V.y;
    p.velocity.x = 0; p.velocity.y = 0;
    gems.initSatchel(p);
    p.carriedGems = carried;
    p._padReentryUntil = 0; p._vaultPush = null;
    vault.tick([p], 33);
    assert.equal(p.vaultOnPad, true, 'on the pad');
}
// backdate the idle clock (and the pad clock) by ms
function idleFor(p, ms) {
    p._vaultIdleSince = Date.now() - ms;
    p._vaultPadSince = Math.min(p._vaultPadSince || Date.now(), Date.now() - ms);
}
const kicked = (p) => (p._padReentryUntil || 0) > Date.now();
function done(p) { try { p.kill(); } catch { /* */ } }

// ===================================================================

test('camp: limits by what they carry, the same for everyone', () => {
    assert.equal(vault.PAD_EJECT_MS, 20_000, 'doubled from 10 s');
    assert.equal(vault.PAD_EJECT_CARRY_MS, 50_000, 'doubled from 25 s');
    assert.equal(vault.REENTRY_MS, 2500, 'halved from 5 s');
    assert.equal(vault.CASHED_LOCK_MS, 10_000, 'halved from 20 s');
    const reg = spawn(120, 0, 0);
    assert.equal(reg._fpProtect, false, 'a regular');
    reg.carriedGems = 0;
    assert.equal(vault.campLimitMs(reg), vault.PAD_EJECT_MS);
    reg.carriedGems = vault.MIN_DEPOSIT;
    assert.equal(vault.campLimitMs(reg), vault.PAD_EJECT_CARRY_MS);
    const nu = spawn(0, 0, 0);
    assert.equal(nu._fpProtect, true, 'a newcomer');
    nu.carriedGems = 186;
    assert.equal(vault.campLimitMs(nu), vault.PAD_EJECT_CARRY_MS, 'a newcomer carrying: the same limit');
    nu.carriedGems = 3;
    assert.equal(vault.campLimitMs(nu), vault.PAD_EJECT_MS);
    // the kick message says the real wait
    assert.equal(vault.secondsText(2500), '2.5 seconds');
    assert.equal(vault.secondsText(10_000), '10 seconds');
    done(reg); done(nu); loop(2);
});

test('camp: someone picking an amount is not kicked at 25 s, warned, kicked at 50 s', () => {
    const p = spawn(120, 0, 0);
    onVault(p, 186);
    // (hold the auto bank off: this is the camp clock on its own)
    const holdAuto = () => { p._autoBankTry = Date.now() + 1e9; };
    holdAuto();
    idleFor(p, 27_000);
    vault.tick([p], 33);
    assert.equal(kicked(p), false, 'past the old 25 s, gems on board');
    idleFor(p, vault.PAD_EJECT_CARRY_MS - 2000);
    vault.tick([p], 33);
    assert.equal(kicked(p), false);
    assert.ok(p.said.some(m => /Bank your gems or move on/.test(m)), 'warned first: ' + p.said.join(' | '));
    // a deposit request (even one the vault turns down) restarts the clock
    p.carriedGems = 5;
    vault.depositFor(p, 0);
    assert.ok(Date.now() - p._vaultIdleSince < 1000, 'clock restarted');
    p.carriedGems = 186;
    idleFor(p, vault.PAD_EJECT_CARRY_MS + 1000);
    vault.tick([p], 33);
    assert.equal(kicked(p), true, 'a real camper still goes');
    assert.ok(p.said.some(m => /No camping on the vault\. You can come back in 2\.5 seconds\./.test(m)), p.said.join(' | '));
    assert.ok(p._padReentryUntil - Date.now() <= 2500 && p._padReentryUntil - Date.now() > 2000, 'a 2.5 s re-entry wait');
    done(p); loop(2);
});

test('camp: an empty-handed sitter still goes after 20 s', () => {
    const p = spawn(120, 0, 0);
    onVault(p, 0);
    idleFor(p, vault.PAD_EJECT_MS - 2000);
    vault.tick([p], 33);
    assert.equal(kicked(p), false, 'not at 18 s');
    idleFor(p, vault.PAD_EJECT_MS + 500);
    vault.tick([p], 33);
    assert.equal(kicked(p), true);
    done(p); loop(2);
});

test('camp: a deposit running is never a camp', () => {
    const p = spawn(120, 0, 0);
    onVault(p, 3000);
    assert.equal(vault.depositFor(p, 0), true);
    idleFor(p, 60_000);
    vault.tick([p], 33);
    assert.equal(kicked(p), false);
    assert.ok(p.vaultDeposit, 'still depositing');
    done(p); loop(2);
});

test('no auto-bank: standing on the pad starts nothing, Bank all banks at the same rate, and a hit cuts it for everyone', () => {
    const rate = (who) => {
        const p = spawn(who, 0, 0);
        const banked0 = (p.socket.gemBanked || 0) | 0;
        onVault(p, 186);
        p._vaultPadSince = Date.now() - vault.AUTO_BANK_MS - 50;
        vault.tick([p], 33);
        assert.ok(!p.vaultDeposit, 'no deposit without the panel (' + who + ' min)');
        assert.equal(vault.depositFor(p, 0), true, 'Bank all');
        assert.equal(p.vaultDeposit.total, 186, 'all of it');
        vault.tick([p], 100);
        const moved = ((p.socket.gemBanked | 0) - banked0);
        done(p); loop(2);
        return moved;
    };
    const prot = rate(0), reg = rate(120);
    assert.equal(prot, reg, 'the same rate protected or not: ' + prot + ' vs ' + reg);
    // a hit mid-deposit cuts it, for a protected player too
    for (const who of [0, 120]) {
        const p = spawn(who, 0, 0);
        onVault(p, 186);
        p._vaultPadSince = Date.now() - vault.AUTO_BANK_MS - 50;
        vault.tick([p], 33);
        assert.ok(!p.vaultDeposit);
        vault.depositFor(p, 0);
        vault.tick([p], 33);
        assert.ok(p.vaultDeposit);
        p.health.amount = Math.max(1, p.health.amount - 5);
        p._inStorm = false;
        vault.tick([p], 33);
        assert.ok(!p.vaultDeposit, 'cut by the hit (' + who + ' min)');
        done(p); loop(2);
    }
    const vs = fs.readFileSync(path.join(SERVER, 'game', 'terrain', 'vault.js'), 'utf8');
    assert.ok(!/protectedNow|PROTECTED_RATE_MULT|sheltered/.test(vs), 'no protected path left in vault.js');
});

test('auto: the panel still works, Bank all banks everything', () => {
    const p = spawn(120, 0, 0);
    onVault(p, 186);
    p._autoBankTry = Date.now() + 1e9;
    vault.tick([p], 33);
    assert.equal(vault.depositFor(p, 0), true, 'Bank all: 0 means everything');
    assert.equal(p.vaultDeposit.total, 186);
    done(p); loop(2);
});

test('numbers: dying never touches gems banked this raid', () => {
    const p = spawn(120, 0, 0);
    const s = p.socket;
    s.gemBanked = 211; s.bankKept = 0;         // the playtest: 186 + the 25 bonus
    p.deathCause = 'bot';
    assert.equal(bank.deathLossFor(p), 0);
    gems.initSatchel(p);
    p.carriedGems = 0;
    gems.dropGemsOnDeath(p, []);
    assert.equal(s.gemBanked, 211, 'still 211');
    assert.equal(s.gemDeathBanked, 211, 'the death card says 211');
    assert.equal(s.gemDeathBankLoss, 0);
    done(p); loop(2);
});

test('numbers: off by default, a death never costs savings (Oct 5 2026)', () => {
    assert.equal(bank.deathLossEnabled(), false);
    const p = spawn(120, 0, 0);
    p.socket.gemBanked = 2500; p.socket.bankKept = 2000;
    p.deathCause = 'bot';
    assert.equal(bank.deathLossFor(p), 0);
    done(p); loop(2);
});

test('numbers: with ROYALE_SAVINGS_DEATH_LOSS=1 savings pay 10% of a death, the raid part stays, the card is honest', () => {
    bank.setDeathLoss(true);
    try { savingsTax(); } finally { bank.setDeathLoss(false); }
});
function savingsTax() {
    const p = spawn(120, 0, 0);
    const s = p.socket;
    s.gemBanked = 2500; s.bankKept = 2000;     // 2000 brought in, 500 banked this raid
    p.deathCause = 'bot';
    const loss = bank.deathLossFor(p);
    assert.equal(loss, Math.floor(2000 * bank.DEATH_SHARE));
    gems.initSatchel(p);
    p.carriedGems = 0;
    gems.dropGemsOnDeath(p, []);
    assert.equal(s.gemBanked, 2500 - loss);
    assert.equal(bank.kept(s), 2000 - loss, 'out of the savings');
    assert.equal(bank.raidPart(s), 500, 'this raid\'s 500 untouched');
    assert.equal(s.gemDeathBanked, 2500 - loss, 'the card shows the balance after');
    assert.equal(s.gemDeathBankLoss, loss);
    const m = s.packets.filter(a => a[0] === 'm').map(a => String(a[2])).join(' | ');
    assert.ok(/Dying cost you 200 gems from your savings/.test(m), m);
    // the cap still holds
    s.gemBanked = 60_000; s.bankKept = 60_000;
    assert.equal(bank.deathLossFor(p), bank.DEATH_MAX);
    done(p); loop(2);
}

test('numbers: a protected player loses nothing to a death', () => {
    const p = spawn(0, 0, 0);
    const s = p.socket;
    s.gemBanked = 3000; s.bankKept = 3000;
    p.deathCause = 'bot';
    assert.equal(bank.deathLossFor(p), 0);
    done(p); loop(2);
});

test('numbers: the death packet carries the loss', () => {
    const src = fs.readFileSync(path.join(SERVER, 'game', 'network', 'sockets.js'), 'utf8');
    assert.ok(/gemDeathKept\) \| 0,\s*\/\/[^\n]*\n\s*\(socket && socket\.gemDeathBankLoss\) \| 0,/.test(src), 'm[19 + killers]');
    const si = fs.readFileSync(path.join(CLIENT, 'socketinit.js'), 'utf8');
    assert.ok(si.includes('global.finalBankLoss = m[19 + m[8]] | 0;'));
});

// ── client wiring ───────────────────────────────────────────────────
const app = fs.readFileSync(path.join(CLIENT, 'app.js'), 'utf8');
const heat = fs.readFileSync(path.join(CLIENT, 'raidHeat.js'), 'utf8');
const coach = fs.readFileSync(path.join(CLIENT, 'coach.js'), 'utf8');
const canvas = fs.readFileSync(path.join(CLIENT, 'canvas.js'), 'utf8');

test('client: the vault panel says gems and leads with Bank all', () => {
    assert.ok(!/dust to cash out/.test(app), 'no "dust" in the vault panel');
    assert.ok(/const allTxt = util\.formatLargeNumber\(g\.carried \| 0\);/.test(app));
    assert.ok(/\(touchBig \? "Bank all " : "Bank all  "\) \+ allTxt \+ " gems"/.test(app));
    assert.ok(/kc === 66 && !global\.died[\s\S]{0,400}this\.socket\.talk\('vd', 0\)/.test(fs.readFileSync(path.join(CLIENT, 'canvas.js'), 'utf8')), 'B on a vault pad banks all');
    assert.ok(/type: "vault", index: 9/.test(app), 'Bank all is a vault clickable');
    assert.ok(/vaultClick === 9\) \{[\s\S]{0,200}talk\('vd', 0\)/.test(canvas), 'and sends 0 = everything');
});

test('client: slams and the death card agree with the HUD', () => {
    assert.ok(/v\.lastDeposit \| 0\) > 0 \? \(v\.lastDeposit \| 0\)/.test(heat), 'BANKED +N is the deposit');
    assert.ok(/bonus \+ " BONUS", "You've banked "/.test(heat), 'the milestone leads with its bonus');
    assert.ok(!/BANKED \(KEPT\)/.test(app), 'no "kept" on the death card');
    // the card shows one points number. The savings paragraph stays in
    // scoreLogic and is not printed on the card.
    const sl = fs.readFileSync(path.join(CLIENT, 'scoreLogic.js'), 'utf8');
    assert.ok(/scoreText\.cardPoints\(you\)/.test(app) && /\["BANKED THIS RAID", num\(pt\.b\), "gem"\]/.test(sl), 'points come from the same parts');
    assert.ok(!/CARRIED \(50% PTS\)/.test(app), 'no half-points satchel tile');
    assert.ok(!/extras\.push\(dln\.savings\)/.test(app) && /You keep 60% for your next life/.test(sl), 'the savings sentence is not on the card');
});

test('client: the coach never steps back and a bank finishes mining', () => {
    assert.ok(!/delete rec\.done\.mine/.test(coach), 'no un-marking on death');
    assert.ok(/if \(rec\.done\.bank\) markDone\("mine"\);/.test(coach));
    assert.ok(/next !== "mine" && next !== "bank"\) st\.dropped = false/.test(coach));
    assert.ok(/<b>Bank all<\/b>/.test(coach), 'the card names the button');
});

let failed = 0;
for (const t of tests) {
    try { t.fn(); console.log('ok   ' + t.name); }
    catch (e) { failed++; console.log('FAIL ' + t.name + '\n     ' + (e && e.stack || e)); }
}
console.log(failed ? `${failed} of ${tests.length} failed` : `all ${tests.length} passed`);
process.exit(failed ? 1 : 0);
