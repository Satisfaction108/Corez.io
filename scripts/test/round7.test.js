// Blind playtest round 6 fixes (round 7): node scripts/test/round7.test.js
//
//   bank cover   anyone banking (deposit running, then 5 s while still in
//                the vault's ring) takes slightly softer shots from everyone,
//                the same 0.85x for all; their killers and tanks with 2x
//                their points don't start on them or shoot while they bank
//                (fairPlay.bankStamp / bankBully, vault.tick, subFunctions
//                shotMult)
//   payday       a first or second raid with little to show 2:30 in gets a
//                big rich vein; a moment that waited on a fight goes once
//                nobody is hitting them (newcomerDirector)
//   respawn      the raid's last lock says so on the button and takes you to
//                the finish; a held-back respawn says why (spawnWhy); the
//                button takes the press, not just a full click
//   button text  "Storm resetting (3s)", and any label shrinks to the button
//   Enter        no chat for 1.2 s after a drop; an empty chat closes on the
//                drop; a held WASD key in a chat of WASD letters closes it
//   bank pops    Deep Pockets' extra has its own pop; the same payout never
//                pops twice; milestones are a bank pop (slam only from 10k);
//                a deposit in two goes is one BANKED number; pops sit above
//                your name
//   bosses       no boss in a raid's first 3 minutes; fresh lives, the raid's
//                first 2 minutes and stock tanks are left alone
//   perks        a fresh offer waits while you're being hit; "Perk ready:
//                pick any time"
//   crowns       "Nearest crown: about 2.1k away" / "Knock it off its holder
//                to steal it"
'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const REPO = path.join(__dirname, '..', '..');
const SERVER = path.join(REPO, 'server');
const CLIENT = path.join(REPO, 'public', 'client');
const src = (f) => fs.readFileSync(path.join(CLIENT, f), 'utf8');
const ssrc = (f) => fs.readFileSync(path.join(SERVER, f), 'utf8');
const imp = (f) => import(pathToFileURL(path.join(CLIENT, f)).href);

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-round7-test-'));
process.env.DATA_DIR = path.join(ROOT, 'data');
for (const k of ['ROYALE_DEBUG', 'ROYALE_CROWNS', 'ROYALE_PERKS', 'ROYALE_END_WAIT_MS', 'DB_PATH', 'PUBLIC_HOST', 'PUBLIC_ORIGIN', 'ALLOWED_ORIGINS', 'ACCOUNTS_ALLOW_DEBUG',
    'ROYALE_BANK_COVER', 'ROYALE_PAYDAY', 'ROYALE_BOSS_FRESH', 'ROYALE_BOSS_EARLY']) delete process.env[k];
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
const handler = new gameHandler(global.gameManager);
global.gameManager.gameHandler = handler;

const T = p => require(path.join(SERVER, 'game', 'terrain', p));
const royale = require(path.join(SERVER, 'game', 'gamemodes', 'scripts', 'dig_royale.js'));
const storm = T('storm.js');
const vault = T('vault.js');
const shop = T('shop.js');
const fair = T('fairPlay.js');
const nx = T('newcomerDirector.js');
const bosses = T('bosses.js');
const bossGuard = T('bossGuard.js');
const { ORE } = T('terrainGrid.js');
const sub = require(path.join(SERVER, 'game', 'entities', 'subFunctions.js'));
const activity = require(path.join(SERVER, 'game', 'network', 'activity.js'));

global.gameManager.terrainGrid = {
    vaultSites: [{ x: 0, y: -3000, r: 95 }],
    shopSites: [{ id: 0, name: 'Shop', x: 3000, y: 0, r: 95 }],
    outpostSites: [], spawnPits: [],
};
vault.getVaults(); shop.getShops();
global.gameManager.terrainGrid = null;
storm.start();
royale.tick();
const V = vault.getVaults()[0];

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

let seq = 0;
function level45(t) {
    while (t.skill.level < 45) { t.skill.score += t.skill.levelScore; t.skill.maintain(); }
    t.refreshBodyAttributes();
}
function mkSocket() {
    const s = { id: 'r7' + (++seq), packets: [], status: {}, camera: { x: 0, y: 0 }, _careerLives: 100, readyState: 1, OPEN: 1 };
    s.talk = (...a) => s.packets.push(a);
    global.gameManager.socketManager.clients.push(s);
    return s;
}
function human(x = 0, y = 0) {
    const sock = mkSocket();
    const t = new Entity({ x, y });
    t.define('basic');
    t.isPlayer = true;
    t.team = -1 - (++seq);
    t.name = 'Hu' + seq;
    t.alwaysActive = true;
    t.msgs = [];
    t.sendMessage = (m) => t.msgs.push(m);
    const player = { socket: sock, body: t, target: { x: 120, y: 0 }, command: { up: 0, down: 0, left: 0, right: 0, lmb: 0, mmb: 0, rmb: 0, autofire: false, autospin: false, override: false } };
    sock.player = player;
    t.socket = sock;
    level45(t);
    global.gameManager.socketManager.players.push(player);
    royale.onHumanJoin(t);
    t.x = x; t.y = y; t.velocity.x = 0; t.velocity.y = 0;
    activity.noteCommand(sock, 100 + seq, 0, 0);
    return t;
}
function bot(x = 0, y = 0) {
    const b = new Entity({ x, y });
    b.define('basic');
    b.isBot = true;
    b.team = -500 - (++seq);
    b.name = 'Bot' + seq;
    b.alwaysActive = true;
    level45(b);
    b.controllers = [];
    global.gameManager.gameHandler.bots.push(b);
    return b;
}
let clock = Date.now();
Date.now = () => clock;
const tick = (ms = 300) => { clock += ms; royale.tick(); };
const kcs = (b, kind) => b.socket.packets.filter(p => p[0] === 'KC' && (!kind || p[1] === kind));
function freshRaid() {
    for (const p of global.gameManager.socketManager.players) if (p.body) { try { p.body.kill(); } catch { /* */ } p.body.health.amount = -1; }
    for (const b of handler.bots) { try { b.kill(); } catch { /* */ } b.health.amount = -1; }
    global.gameManager.socketManager.players.length = 0;
    global.gameManager.socketManager.clients.length = 0;
    handler.bots.length = 0;
    royale.debugEndRaid();
    tick(6000);
}
// a client function out of a source file, by name (they live in closures)
function grabFn(file, name, extra = '') {
    const s = src(file);
    const i = s.indexOf('function ' + name + '(');
    assert.ok(i >= 0, name + ' in ' + file);
    let d = 0, j = s.indexOf('{', i);
    for (let k = j; k < s.length; k++) { if (s[k] === '{') d++; else if (s[k] === '}') { d--; if (!d) { j = k + 1; break; } } }
    return new Function('global', extra + s.slice(i, j) + '\nreturn ' + name + ';');
}

// ── 1. bank cover ────────────────────────────────────────────────────────
test('bank cover: a deposit and 5 s after it, inside the ring: slightly softer shots, the same for everyone', () => {
    freshRaid();
    const h = human(V.x, V.y);
    const t = Date.now();
    h.carriedGems = 0;
    assert.equal(fair.bankStamp(h, V, t), fair.TUNE.BANK_COVER_MULT);
    assert.equal(h._fpBank, 2);
    // a protected player gets exactly the same
    h._fpProtect = true;
    const pm = fair.bankStamp(h, V, t);
    h._fpProtect = false;
    assert.equal(pm, fair.bankStamp(h, V, t), 'no bigger cut when protected');
    assert.equal(fair.TUNE.BANK_COVER_PROTECT_MULT, undefined);
    if (!process.env.ROYALE_BANK_COVER_CUT) assert.equal(fair.TUNE.BANK_COVER_MULT, 0.85, 'mild: 15% off');
    assert.ok(fair.TUNE.BANK_COVER_MULT >= 0.5 && fair.TUNE.BANK_COVER_MULT < 1, 'a reduction, never invulnerable');
    // shoved off the pad but still in the ring, 4 s on: still covered
    h.x = V.x + 300;
    assert.ok(fair.bankStamp(h, null, t + 4000) > 0);
    // 5 s on: gone; outside the ring: gone
    assert.equal(fair.bankStamp(h, null, t + 5200), 0);
    fair.bankStamp(h, V, t + 6000);
    h.x = V.x + fair.zoneR(V) + 50;
    assert.equal(fair.bankStamp(h, null, t + 6100), 0);
    // on the way in with something to bank: no cut, but marked
    h.x = V.x + 300; h.carriedGems = 200;
    assert.equal(fair.bankStamp(h, null, t + 20000), 0);
    assert.equal(h._fpBank, 1);
    // a bot banking gets the same cover
    const b = bot(V.x, V.y + 200);
    assert.equal(fair.bankStamp(b, V, t), fair.TUNE.BANK_COVER_MULT, 'bots too');
    assert.equal(b._fpBank, 2);
});

test('bank cover: shots into a covered player are scaled, from bots and players alike', () => {
    freshRaid();
    const h = human(V.x, V.y), p = human(V.x + 600, V.y), b = bot(V.x - 600, V.y);
    h._bankCover = 0.55;
    const bullet = (owner) => { const o = new Entity({ x: owner.x, y: owner.y }); o.master = owner; o.source = owner; return o; };
    const pb = bullet(p), bb = bullet(b);
    h._bankCover = 0;
    const p0 = sub.shotMult(pb, h), b0 = sub.shotMult(bb, h);
    h._bankCover = 0.55;
    assert.ok(Math.abs(sub.shotMult(pb, h) - p0 * 0.55) < 1e-9, 'player shot');
    assert.ok(Math.abs(sub.shotMult(bb, h) - b0 * 0.55) < 1e-9, 'bot shot');
    // the covered player's own shots are untouched
    const hb = bullet(h);
    assert.equal(sub.shotMult(hb, p), sub.shotMult(hb, p));
    h._bankCover = 0;
    for (const o of [pb, bb, hb]) { try { o.kill(); o.destroy(); } catch { /* */ } }
});

test('bank cover: killers and 2x tanks leave a protected player banking alone (bots hold fire); others may still fight', () => {
    freshRaid();
    const h = human(V.x + 200, V.y);
    const killer = bot(V.x + 600, V.y), big = bot(V.x - 600, V.y), even = bot(V.x, V.y + 600);
    const t = Date.now();
    h._fpBank = 2; h._fpPts = 300; killer._fpPts = 400; big._fpPts = 900; even._fpPts = 350;
    fair.noteKilledBy(h.socket, killer, t, 1);
    // round 8: only a protected player gets the hold-off
    fair.stamp(h, { stage: 3, newness: 0, struggle: 0 });
    assert.equal(fair.bankBully(killer, h, t), false, 'a veteran banking: their killer may come');
    assert.equal(fair.bankBully(big, h, t), false, 'a veteran banking: so may a 2x tank');
    fair.stamp(h, { stage: 0, newness: 1, struggle: 0 });
    assert.equal(fair.bankBully(killer, h, t), true, 'the tank that killed them');
    assert.equal(fair.bankBully(big, h, t), true, '2x their points');
    assert.equal(fair.bankBully(even, h, t), false, 'an even bot may still fight');
    const G = ioTypes.digWarsGoals;
    const c = new G(killer);
    h.invuln = false; h.spawnGraceUntil = 0; h.botGraceUntil = 0; h.botSoftUntil = 0;
    assert.equal(c.canInitiateFight(h, t + 10), false, 'no fight started on them while they bank');
    assert.equal(new ioTypes.nearestDifferentMaster(killer).validate(h, killer, killer, 1e12, 1e12), false, 'and its guns hold fire');
    // done banking, out of cover: fair game again
    h._fpBank = 0;
    assert.equal(fair.bankBully(killer, h, t), false);
    // the switch
    fair.setSwitch('bankCover', false);
    try { assert.equal(fair.bankStamp(h, V, t), 0); h._fpBank = 2; assert.equal(fair.bankBully(killer, h, t), false); }
    finally { fair.setSwitch('bankCover', true); }
    for (const o of [h, killer, big, even]) { try { o.kill(); } catch { /* */ } }
});

test('bank cover: vault.tick stamps it during a deposit; the camp kick is untouched', () => {
    freshRaid();
    const h = human(V.x, V.y);
    h.carriedGems = 400;
    const actors = [h];
    vault.tick(actors, 33);
    assert.ok(vault.depositFor(h, 400) || h.vaultDeposit, 'deposit started');
    vault.tick(actors, 33);
    assert.equal(h._fpBank, 2);
    assert.ok(h._bankCover > 0 && h._bankCover < 1);
    // nothing to bank: the anti-camp limit is the same as before
    assert.equal(vault.campLimitMs({ carriedGems: 0 }), vault.PAD_EJECT_MS);
    const vs = fs.readFileSync(path.join(SERVER, 'game', 'terrain', 'vault.js'), 'utf8');
    assert.match(vs, /fairPlay\(\)\.bankStamp\(body, body\.vaultDeposit \? \(body\._vaultSite \|\| pad\) : null, now, list\)/);
    assert.match(vs, /if \(Config\.dig_royale\) \{\n\s*try \{ fairPlay\(\)\.bankStamp/, 'every tank, not just humans');
    assert.match(ssrc('game/entities/subFunctions.js'), /if \(hit && hit\._bankCover > 0 && hit !== root\) m \*= fairPlay\(\)\.bankCoverMult\(hit\);/);
    assert.match(ssrc('game/gamemodes/scripts/dig_royale.js'), /b\._fpPts = scoreOfBody\(b\);/);
});

// ── 2. payday ────────────────────────────────────────────────────────────
function fakeGrid(cx, cy) {
    const rocks = new Map();
    let k = 0;
    for (let i = 0; i < 9; i++) {
        const x = cx + 330 + (i % 3) * 70, y = cy - 70 + Math.floor(i / 3) * 70;
        rocks.set(++k, { k, alive: true, ore: 0, worldPoly: [[x - 20, y - 20], [x + 20, y - 20], [x + 20, y + 20]], worldCx: x, worldCy: y, wx: x, wy: y });
    }
    return { rocks, plainRockHealth: 100, _buildDeposits: () => null, rockEvents: [] };
}
test('payday: a first or second raid with little to show 2:30 in gets a big vein, once', () => {
    freshRaid();
    const st0 = storm.snapshot();
    const h = human(st0.cx, st0.cy);
    h.carriedGems = 0;
    nx.debugFire(h, 'stage', 1);
    const st = nx.stateOf(h.socket);
    assert.equal(st.startStage, 1);
    const t0 = st.since;
    h.royaleBornAt = t0;
    h.hitAt = 0; h._lastDamageAt = 0; h._dealtAt = 0;
    activity.noteCommand(h.socket, 9000 + seq, 0, 0);
    global.gameManager.terrainGrid = fakeGrid(h.x, h.y);
    const modsWas = global.royaleMods;
    global.royaleMods = Object.assign({}, modsWas || {}, { ore: null });   // not the copper-only twist
    try {
        assert.equal(nx.tickPayday(h, st, t0 + 60_000), false, 'not before 2:30');
        // shooting at things (not being hit) no longer holds it back past 4:00
        const at = (ms) => { clock = t0 + ms; activity.noteCommand(h.socket, 9000 + ms, (ms & 1) ? 1 : 0, 0); return clock; };
        h._dealtAt = t0 + 150_500;
        assert.equal(nx.tickPayday(h, st, at(151_000)), false, 'busy shooting before 4:00: waits');
        h._dealtAt = t0 + 240_500;
        const why = nx.busyWhy(h, at(241_001), true);
        assert.equal(why, null, 'busy: ' + why);
        assert.equal(nx.tickPayday(h, st, at(241_000)), true, 'past 4:00 only a hit holds it');
        assert.equal(st.payday, 1);
        const rich = [...global.gameManager.terrainGrid.rocks.values()].filter(r => r.ore);
        assert.equal(rich.length, 6, 'six rocks');
        assert.equal(rich.filter(r => r.ore === ORE.SHARD).length, 2, 'two shards');
        assert.ok(rich.every(r => r.soft), 'soft');
        assert.ok(h.msgs.concat(h.socket.packets.filter(p => p[0] === 'm').map(p => p[2])).some(m => /There's a payday vein to your \w+, with two shards in it\./.test(m)));
        assert.equal(nx.tickPayday(h, st, at(250_000)), false, 'once');
    } finally { global.gameManager.terrainGrid = null; global.royaleMods = modsWas; }
});

test('payday: veterans never, and not for someone already doing fine', () => {
    freshRaid();
    const st0 = storm.snapshot();
    const v = human(st0.cx, st0.cy);
    nx.debugFire(v, 'stage', 3);
    const sv = nx.stateOf(v.socket);
    global.gameManager.terrainGrid = fakeGrid(v.x, v.y);
    try {
        assert.equal(nx.tickPayday(v, sv, sv.since + 200_000), false);
        assert.equal(sv.payday, 0, 'a veteran is never looked at');
        const r = human(st0.cx, st0.cy);
        nx.debugFire(r, 'stage', 0);
        const sr = nx.stateOf(r.socket);
        r.carriedGems = 900;
        assert.equal(nx.tickPayday(r, sr, sr.since + 200_000), false);
        assert.equal(sr.payday, 2, 'already has plenty');
    } finally { global.gameManager.terrainGrid = null; }
    nx.setPayday(false);
    try {
        const w = human(st0.cx, st0.cy);
        nx.debugFire(w, 'stage', 0);
        assert.equal(nx.tickPayday(w, nx.stateOf(w.socket), Date.now() + 200_000), false, 'ROYALE_PAYDAY=0');
    } finally { nx.setPayday(true); }
});

test('moments: one that waited 30 s on a fight goes once nobody is hitting them', () => {
    const b = { royaleBornAt: 0, hitAt: 0, _lastDamageAt: 0, _dealtAt: 100_000, socket: null, team: -9, x: 0, y: 0, isDead: () => false };
    assert.equal(nx.busyWhy(b, 101_000, false), 'fighting', 'shooting holds a fresh one');
    assert.equal(nx.busyWhy(b, 101_000, true), null, 'overdue: shooting no longer does');
    b.hitAt = 100_500;
    assert.equal(nx.busyWhy(b, 101_000, true), 'fighting', 'being hit still does');
    assert.match(ssrc('game/terrain/newcomerDirector.js'), /const overdue = t - \(st\.wantAt \|\| st\.dueAt\) > TUNE\.OVERDUE_MS;/);
});

// ── 3. respawn near the end ──────────────────────────────────────────────
test('respawn: the raid\'s last lock says so and takes you to the finish; a held-back spawn says why', () => {
    const app = src('app.js');
    assert.match(app, /if \(global\.royale\.storm && global\.royale\.storm\.fin\) return \{ ready: false, ended: true, label: "No more respawns this raid" \};/);
    assert.match(app, /else if \(now - again\._endedAt > 2500 && !global\.royaleSpectating\) royaleDomAct\("spectate"\);/);
    assert.match(app, /royaleDomAct\(again\.dataset\.ended \? "spectate" : "play"\);/);
    assert.match(app, /again\.addEventListener\("pointerdown", \(e\) => \{ if \(e\.button === 0 \|\| e\.pointerType === "touch"\) \{ e\.preventDefault\(\); againAct\(\); \} \}\);/, 'the press counts, not just a full click');
    assert.match(app, /const label = finalLock \? "No more respawns this raid"/);
    const cv = src('canvas.js');
    assert.match(cv, /if \(global\.died && !global\.tutorialMode && global\.royale && global\.royale\.lock && global\.royale\.at > 0 && global\.royale\.storm && global\.royale\.storm\.fin\) \{/);
    const so = ssrc('game/network/sockets.js');
    assert.match(so, /if \(!dr\.canSpawn\(\)\) \{ tellWhy\(dr\); return; \}/);
    // the server's words
    assert.match(royale.spawnWhy(), /storm is resetting|raid is ending|raid is over/);
    const end = storm.debugFinal(20);
    assert.ok(isFinite(end));
    assert.equal(royale.spawnWhy(), "The raid is ending, so there are no more respawns. You can watch the finish.");
    storm.start();
});

// ── 4. button text ───────────────────────────────────────────────────────
test('button text: "Storm resetting (3s)", and every label fits the button', () => {
    const app = src('app.js');
    assert.match(app, /return \{ ready: false, queue: true, queued: q, label: q \? "Storm resetting: you drop in \(" \+ left \+ "s\)" : "Storm resetting \(" \+ left \+ "s\)" \};/);
    assert.ok(!/No spawns while the storm shuts/.test(app));
    const font = grabFn('app.js', 'playAgainFont')({});
    for (const [label, ready, w] of [["Storm resetting (45s)", false, 380], ["Storm resetting: you drop in (45s)", false, 380], ["No more respawns this raid", false, 380],
        ["Respawn", true, 380], ["No more respawns this raid", false, 300]]) {
        const fs0 = parseFloat(font({ label, ready, ended: /No more respawns/.test(label) }, { w, big: false }, ready ? "Enter" : ""));
        const room = (w - 36 - (ready ? 64 : 0)) * (/No more respawns/.test(label) ? 2 : 1);
        assert.ok(label.length * 0.55 * fs0 <= room + 1 || fs0 === 12, label + ' at ' + fs0 + 'px in ' + w);
        assert.ok(fs0 >= 12 && fs0 <= 26);
    }
    assert.equal(font({ label: "Respawn", ready: true }, { w: 380, big: true }, "Enter"), "34px", 'the first raids\' big word stays big');
    assert.match(fs.readFileSync(path.join(REPO, 'public', 'home.css'), 'utf8'), /\.dw-igbtn\.play \.pa-label \{ white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; \}/);
});

// ── 5. Enter after a respawn ─────────────────────────────────────────────
test('Enter: no chat right after a drop; a mashed chat closes; an empty one closes on the drop', () => {
    const g = { spawnedAt: 1000 };
    const guard = grabFn('canvas.js', 'enterGuarded', 'const ENTER_GUARD_MS = 1200;\n')(g);
    assert.equal(guard(1500), true);
    assert.equal(guard(2300), false);
    const mash = grabFn('canvas.js', 'chatIsMash', 'const MOVE_KEYS = [87, 65, 83, 68];\n')(g);
    assert.equal(mash('wwww', 87), true);
    assert.equal(mash('', 68), true);
    assert.equal(mash('WASD w', 65), true);
    assert.equal(mash('was here', 87), false, 'real words stay');
    assert.equal(mash('wwww', 13), false, 'only movement keys');
    const cv = src('canvas.js');
    assert.match(cv, /if \(event\.repeat && chatIsMash\(this\[id\] && this\[id\]\.value, event\.keyCode\)\) \{/);
    assert.match(cv, /if \(enterGuarded\(performance\.now\(\)\)\) break;\n\s+this\.spawnChatInput\(\);/);
    assert.match(src('socketinit.js'), /if \(global\.showChat && cv && cv\.chatInput && !String\(cv\.chatInput\.value \|\| ""\)\.trim\(\)\) cv\.closeChat\(\);/);
});

// ── 6. bank pops ─────────────────────────────────────────────────────────
test('bank pops: a payout inside a deposit pops now; the same payout never pops twice', async () => {
    const B = await imp('bankPopLogic.js');
    const st = B.create();
    B.onBanked(st, 100, 0);
    // a deposit's rise is the BANKED slam's, Deep Pockets' share pops on its own
    B.onBanked(st, 1200, 100, { deposit: true });
    assert.equal(st.pops.length, 0);
    B.note(st, 100, 'Deep Pockets 110%', 150);
    assert.deepEqual(st.pops.map(p => p.str), ['+100 banked · Deep Pockets 110%']);
    // a label sent twice is one pop
    B.label(st, 250, 'milestone 1,000', 200);
    B.label(st, 250, 'milestone 1,000', 210);
    B.onBanked(st, 1700, 300, { deposit: true });
    assert.deepEqual(st.pops.map(p => p.str), ['+100 banked · Deep Pockets 110%', '+250 banked · milestone 1,000']);
    B.note(st, 250, 'milestone 1,000', 400);
    assert.equal(st.pops.length, 2, 'a repeat refreshes the one up');
    const si = src('socketinit.js');
    assert.match(si, /if \(\(m\[3\] \| 0\) === 1\) bankPops\.note\(bp, m\[2\] \| 0, String\(m\[1\] \|\| ""\), performance\.now\(\)\);/);
    assert.match(si, /if \(at >= 10000\) try \{ raidHeat\.slamBanked\(/, 'a milestone is the bank pop; the slam is for the big rungs');
    assert.match(si, /v\.lastDeposit = \(\(m\[1\] \| 0\) \|\| \(v\.total \| 0\)\) \+ \(performance\.now\(\) - \(v\.partAt \|\| -1e9\) < 10000 \? v\.partBanked \| 0 : 0\);/, 'a deposit in two goes is one number');
    assert.match(src('app.js'), /drawBankPops\(global\.screenWidth \/ 2, Math\.round\(y - 10 - 4\) - 1 - 30( - \(selfTankName\(\) \? SELF_TANK_LIFT : 0\))?\);/, 'above the name, never on it (round 8: centred like it; lifted with the tank line)');
});

test('bank pops: the Deep Pockets premium goes out labelled when the deposit ends', () => {
    freshRaid();
    const h = human(V.x, V.y);
    const was = global.royaleMods;
    global.royaleMods = Object.assign({}, was || {}, { name: 'Deep Pockets', bankMult: 1.1 });
    try {
        h.carriedGems = 300;
        const actors = [h];
        vault.tick(actors, 33);
        vault.depositFor(h, 300);
        for (let i = 0; i < 200 && h.vaultDeposit; i++) vault.tick(actors, 100);
        assert.ok(!h.vaultDeposit, 'done');
        const pop = kcs(h, 'bankpop').pop();
        assert.ok(pop, 'a bankpop went out');
        assert.equal(pop[2], 'Deep Pockets 110%');
        assert.equal(pop[3], 30);
        assert.equal(pop[4], 1, 'already in the bank');
    } finally { global.royaleMods = was; }
});

// ── 7. bosses ────────────────────────────────────────────────────────────
test('bosses: none in a raid\'s first 3 minutes; later cycles keep the 25 s', () => {
    assert.ok(bosses.FIRST_CYCLE_DELAY_MS >= 180_000, String(bosses.FIRST_CYCLE_DELAY_MS));
    assert.equal(bosses.CYCLE_SPAWN_DELAY_MS, 25_000);
    assert.match(ssrc('game/terrain/bosses.js'), /nextAt = cycleBosses === 0 \? cycleStart \+ \(cyc === 0 \? FIRST_CYCLE_DELAY_MS : CYCLE_SPAWN_DELAY_MS\) : t;/);
    bosses.resetRaid();
    storm.start();
    const t0 = Date.now();
    bosses.tick(t0 + 30_000, 6);
    assert.equal(bosses.current(), null, 'not at 0:30');
    bosses.tick(t0 + 120_000, 6);
    assert.equal(bosses.current(), null, 'not at 2:00');
    bosses.tick(t0 + 190_000, 6);
    const b = bosses.current();
    assert.ok(b, 'up after 3:00');
    bosses.resetRaid();
});

test('bosses: a fresh life (anyone\'s) and a raid\'s first 2 minutes take part of a boss hit; nothing more', () => {
    const t = Date.now();
    global.royaleRaidStartAt = t - 600_000;
    const p = { isPlayer: true, isDead: () => false, royaleBornAt: t - 10_000, defs: ['basic'], socket: null, health: { amount: 200 }, damageReceived: 0 };
    assert.equal(bossGuard.freshSpared(p, t), true, 'a 10 s old life');
    p.royaleBornAt = t - bossGuard.FRESH_LIFE_MS - 1000;
    assert.equal(bossGuard.freshSpared(p, t), false, 'a stock Basic past the fresh window is fair game (no Basic rule)');
    p.defs = ['basic', 'twin'];
    assert.equal(bossGuard.freshSpared(p, t), false);
    global.royaleRaidStartAt = t - 60_000;
    p.royaleBornAt = t - 90_000;
    assert.equal(bossGuard.freshSpared(p, t), true, 'the raid\'s first two minutes (a life from its start)');
    p.royaleBornAt = 0;
    assert.equal(bossGuard.freshSpared(p, t), false, 'a body with no life clock is not new');
    p.royaleBornAt = t - 90_000;
    p._hitBossAt = t - 1000;
    assert.equal(bossGuard.freshSpared(p, t), false, 'shooting the boss is picking the fight');
    p._hitBossAt = 0;
    // milder than before: 0.6x (was 0.3x) for at most 45 s (was 75 s, 150 s for a Basic)
    assert.equal(bossGuard.FRESH_DMG, 0.6);
    assert.equal(bossGuard.FRESH_LIFE_MS, 45_000);
    // the damage: a share, and it can still kill (no last-point floor)
    const boss = { isRoyaleBoss: true, bossKind: 'drillhead' };
    const shot = { master: boss, type: 'bullet' };
    const dmg = bossGuard.intoPlayer(p, shot, 100, t);
    assert.ok(Math.abs(dmg - 100 * bossGuard.FRESH_DMG) < 1e-9, String(dmg));
    p.health.amount = 10;
    assert.ok(bossGuard.intoPlayer(p, shot, 500, t) > 10, 'no floor: a big enough hit kills');
    // a newcomer is not treated any differently (the newness mercy is off)
    const fresh = { isPlayer: true, isDead: () => false, royaleBornAt: t - 600_000, botNewbie: true, botNewness: 1, nxBossSafe: true, health: { amount: 200 }, damageReceived: 0 };
    global.royaleRaidStartAt = t - 600_000;
    assert.equal(bossGuard.intoPlayer(fresh, shot, 100, t), 100, 'a newcomer takes a boss hit like anyone');
    bossGuard.setFresh(false);
    try { assert.equal(bossGuard.freshSpared(p, t), false); } finally { bossGuard.setFresh(true); }
    assert.match(fs.readFileSync(path.join(SERVER, 'miscFiles', 'controllers.js'), 'utf8'), /if \(myMaster\.isRoyaleBoss && theirMaster\.isPlayer && bossGuard\.freshSpared\(theirMaster\)\) return false;/);
    global.royaleRaidStartAt = 0;
});

// ── 8. perks ─────────────────────────────────────────────────────────────
test('perks: a fresh offer waits while you\'re hit, then comes out; it says there\'s no rush', async () => {
    const L = await imp('raidPerksLogic.js');
    assert.equal(L.viewFor({ shown: false }, { now: 10_000, key: 'a', hurtAt: 9_000 }), '', 'hit a second ago: waits');
    assert.equal(L.viewFor({ shown: false }, { now: 12_000, key: 'a', hurtAt: 9_000 }), 'cards', 'calm 2.5 s: out');
    assert.equal(L.viewFor({ shown: true }, { now: 10_000, key: 'a', hurtAt: 9_900 }), 'cards', 'once out, a hit does not hide it');
    assert.equal(L.viewFor({}, { now: 10, key: 'a' }), 'cards', 'no hit known: out');
    assert.equal(L.HEAD_TITLE + ": " + L.HEAD_NOTE, 'Perk ready: Pick one any time');
    const rp = src('raidPerks.js');
    assert.match(rp, /if \(view === "cards" && S\.key && S\.shownKey !== S\.key\) \{ S\.shownKey = S\.key; S\.openedAt = now; \}/);
    assert.match(src('socketinit.js'), /if \(m\[3\] \| 0\) global\.hurtAt = performance\.now\(\);/);
});

// ── 9. crowns ────────────────────────────────────────────────────────────
test('crowns: the standings line says it in plain words', async () => {
    const L = await imp('crownsLogic.js');
    const c = { on: 1, list: [{ e: 1, n: 'Ann', s: 5000, x: 2100, y: 0, f: 1 }] };
    const fd = (d) => d >= 1000 ? (d / 1000).toFixed(1) + "k" : String(Math.round(d));
    const t = L.tracker(c, 9, 0, 0, fd);
    assert.equal(t.footer, 'Nearest crown: about 2.1k away');
    assert.equal(t.footer2, 'Kill the holder to steal it');
    c.list[0].f = 0;
    assert.equal(L.tracker(c, 9, 0, 0, fd).footer, 'Nearest crown: 2.1k away');
    assert.equal(L.tracker(c, 1, 0, 0, fd).footer2, '', 'your own crown: no steal line');
    assert.match(src('crowns.js'), /if \(t\.footer2\) A\.drawText\(t\.footer2, x \+ W - 12, ry \+ 22, footSize\(t\.footer2, W - 24, 10\), HUD\.text2, "right", true\);/);
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
