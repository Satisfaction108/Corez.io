// Round 9 client (and the build-button packet): node scripts/test/round9client.test.js
//
//   buttons    Respawn / Respawn as <Tank>, Last tank, Same stats / Random:
//              labels, when they show, the "rb" packet the server validates
//   words      Team Bank, "points lost: 0" + one savings line, "1 point"
//   finale     the results can't be skipped by a respawn, the subtitle
//              clears the title, progress rows (rank, next unlock, bests)
//   dust       mining dust is pooled and capped
'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const REPO = path.join(__dirname, '..', '..');
const CLIENT = path.join(REPO, 'public', 'client');
const src = (f) => fs.readFileSync(path.join(CLIENT, f), 'utf8');
const ssrc = (f) => fs.readFileSync(path.join(REPO, 'server', f), 'utf8');
const imp = (f) => import(pathToFileURL(path.join(CLIENT, f)).href);
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ── the server side of the buttons (respawnBuild.js), on fake classes ──
global.Config = { dig_royale: true, tutorial: false, spawn_class: 'basic', tier_cap: 4 };
const C = {};
const mk = (name, idx, kids) => (C[name] = { LABEL: name, index: idx, UPGRADES_TIER_1: kids });
mk('minigun', 4, []); mk('gunner', 5, []);
mk('machine', 3, ['minigun', 'gunner']);
mk('twin', 2, []);
mk('basic', 1, ['twin', 'machine']);
global.ensureIsClass = (d) => { if (typeof d === 'object') return d; if (d in C) return C[d]; throw new Error('no ' + d); };
const RB = require(path.join(REPO, 'server', 'game', 'terrain', 'respawnBuild.js'));
RB.setRaidOf(() => 7);

// a body that upgrades along its menu like entity.upgrade()
function body(def, points = 50, level = 45) {
    const b = {
        defs: [C[def]], upgrades: [], label: def, isDead: () => false, msgs: [],
        skill: { raw: new Array(11).fill(0), caps: new Array(11).fill(9), points, level, set(r) { this.raw = r.slice(); } },
        guns: { size: 1 },
        refreshBodyAttributes() { }, syncSkillsToGuns() { }, sendMessage(m) { this.msgs.push(m); },
        menu() { this.upgrades = RB.children(this.defs[0]).map(c => ({ class: [c], level: 15, tier: 1, branch: 0, index: String(c.index) })); },
        upgrade(i) { const u = this.upgrades[i]; if (!u || this.skill.level < u.level) return; this.defs = [u.class[0]]; this.label = u.class[0].LABEL; this.menu(); },
    };
    b.menu();
    return b;
}
const sock = (b) => { const s = { player: { body: b } }; b.socket = s; return s; };

test('rb: the tree path, saved build and you-packet fields', () => {
    assert.deepEqual(RB.pathTo('basic', 'minigun').map(c => c.LABEL), ['machine', 'minigun']);
    assert.equal(RB.pathTo('twin', 'minigun'), null, 'not below a sibling');
    const dead = body('minigun');
    dead.skill.raw = [7, 7, 5, 7, 4, 2, 0, 5, 2, 5, 6];
    const s = sock(dead);
    RB.save(s, dead, 7);
    assert.equal(s._rbLast.name, 'minigun');
    // a quick basic death with nothing spent keeps the older build
    RB.save(s, body('basic'), 7);
    assert.equal(s._rbLast.name, 'minigun');
    const fresh = body('basic');
    s.player.body = fresh; fresh.socket = s;
    assert.deepEqual(RB.youFields(s, fresh), { lt: 'minigun', ls: 1, ltu: 1 });
    const twin = body('twin');
    assert.equal(RB.youFields(s, twin).ltu, undefined, 'no tank button off the path');
    RB.setRaidOf(() => 8);
    assert.equal(RB.youFields(s, fresh), null, 'a new raid forgets it');
    RB.setRaidOf(() => 7);
});

test('rb: a reconnect keeps the saved build (resume token / account), the card says why when there is none', async () => {
    const dead = body('minigun');
    dead.skill.raw = [7, 7, 5, 7, 4, 2, 0, 5, 2, 5, 6];
    const s = sock(dead);
    s.resumeToken = 'tok-recon-1';
    RB.save(s, dead, 7);
    // a reload: a new socket with the same token, dead, nothing saved on it
    const s2 = { player: { body: null }, resumeToken: 'tok-recon-1' };
    assert.deepEqual(RB.youFields(s2, null), { lt: 'minigun', ls: 1 });
    assert.equal(RB.request(s2, 'build'), 'queued', 'the death card button works');
    // an account on another worker socket
    const a1 = body('minigun'); a1.skill.raw[0] = 3;
    const sa = sock(a1); sa.account = { id: 99 };
    RB.save(sa, a1, 7);
    assert.equal(RB.youFields({ account: { id: 99 } }, null).lt, 'minigun');
    // another raid: not adopted
    RB.setRaidOf(() => 9);
    assert.equal(RB.youFields({ resumeToken: 'tok-recon-1' }, null), null);
    RB.setRaidOf(() => 7);
    const L = await imp('buildButtonsLogic.js');
    assert.equal(L.respawnAsWhy({ lt: 'Minigun', ls: 1 }, 'Minigun', 5000), '', 'offered: no reason');
    assert.equal(L.respawnAsWhy({}, 'Minigun', 500), '', 'waits for the RY');
    assert.equal(L.respawnAsWhy({}, 'Basic', 5000), '', 'a Basic needs no reason');
    assert.equal(L.respawnAsWhy({}, 'Minigun', 2000), 'Your Minigun build was not saved, so this drop starts as Basic.');
    assert.ok(fs.readFileSync(path.join(REPO, 'public', 'client', 'app.js'), 'utf8').includes('buildBtnLabels.respawnAsWhy('));
});
test('rb: tank / stats / random / build are validated and legal', () => {
    const dead = body('minigun');
    dead.skill.raw = [7, 7, 5, 7, 4, 2, 0, 5, 2, 5, 6];
    const s = sock(dead);
    RB.save(s, dead, 7);
    const b = body('basic');
    s.player.body = b; b.socket = s;
    assert.equal(RB.request(s, 'nonsense'), '');
    assert.equal(RB.request(s, 5), '');
    assert.equal(RB.request(s, 'tank'), 'tank');
    assert.equal(b.defs[0].LABEL, 'minigun');
    assert.equal(b.skill.points, 50, 'tank keeps the points');
    assert.equal(RB.request(s, 'stats'), 'stats');
    assert.deepEqual(b.skill.raw, [7, 7, 5, 7, 4, 2, 0, 5, 2, 5, 6]);
    assert.equal(b.skill.points, 0);
    assert.equal(RB.request(s, 'stats'), '', 'no points left: nothing');
    // a low level can't climb past what it may take
    const low = body('basic', 50, 10);
    const s2 = sock(low); s2._rbLast = s._rbLast;
    assert.equal(RB.request(s2, 'tank'), '');
    // only a few points: only those get placed, never past a cap
    const few = body('basic', 6);
    const s3 = sock(few); s3._rbLast = s._rbLast;
    RB.request(s3, 'stats');
    assert.equal(few.skill.raw.reduce((a, v) => a + v, 0), 6);
    assert.equal(few.skill.points, 0);
    // random: a legal tank and every point placed, caps kept
    const r = body('basic');
    const s4 = sock(r);
    assert.equal(RB.request(s4, 'random'), 'random');
    assert.ok(['minigun', 'gunner', 'twin'].includes(r.defs[0].LABEL), r.defs[0].LABEL);
    assert.equal(r.skill.raw.reduce((a, v) => a + v, 0), 50);
    assert.ok(r.skill.raw.every(v => v <= 9));
    // dead: only 'build', and it waits for the spawn
    const s5 = { player: { body: null }, _rbLast: s._rbLast };
    assert.equal(RB.request(s5, 'stats'), '');
    assert.equal(RB.request(s5, 'build'), 'queued');
    const nb = body('basic');
    assert.equal(RB.onSpawn(s5, nb), true);
    assert.equal(nb.defs[0].LABEL, 'minigun');
    assert.deepEqual(nb.skill.raw, [7, 7, 5, 7, 4, 2, 0, 5, 2, 5, 6]);
    assert.equal(s5._rbWant, false);
    // nothing saved: the button can't queue anything
    assert.equal(RB.request({ player: { body: null } }, 'build'), '');
});

test('rb: randomFit is a sensible spread, fitOnTop pays only from points', () => {
    let seed = 3; const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 20; i++) {
        const f = RB.randomFit(new Array(11).fill(0), 50, new Array(11).fill(9), false, rand);
        assert.equal(f.left, 0);
        assert.equal(f.raw[6], 0, 'a gun build puts nothing in body damage');
        assert.ok(f.raw.every(v => v >= 0 && v <= 9));
    }
    const t = RB.fitOnTop([2, 0, 0], [5, 5, 5], 4, [9, 9, 9]);
    assert.deepEqual(t, { raw: [5, 1, 0], left: 0 });
});

test('rb: the packet in sockets.js, the save at death, the RY fields', () => {
    const so = ssrc('game/network/sockets.js');
    assert.match(so, /case "rb": \{[\s\S]{0,400}m\.length !== 1 \|\| typeof m\[0\] !== "string"[\s\S]{0,300}respawnBuild\.js'\)\.request\(socket, m\[0\]\)/);
    assert.match(so, /socket\._rbWant\)[\s\S]{0,200}respawnBuild\.js'\)\.onSpawn\(socket, socket\.player\.body\)/);
    const dr = ssrc('game/gamemodes/scripts/dig_royale.js');
    assert.match(dr, /respawnBuild\.save\(body\.socket, body, raidId\)/);
    assert.match(dr, /respawnBuild\.youFields\(client, bodyLive \? body : null\)/);
    // the automatic keep-build stays off
    assert.match(ssrc('game/terrain/fairPlay.js'), /build: process\.env\.ROYALE_KEEP_BUILD === '1'/);
});

test('buttons: labels and when they show', async () => {
    const L = await imp('buildButtonsLogic.js');
    assert.deepEqual(L.respawnAs({ lt: 'Minigun', ls: 1 }), { label: 'Respawn as Minigun', sub: 'same tank and stats' });
    assert.equal(L.respawnAs({}), null, 'no last build: one button');
    // playtest 9: the RY can still name the previous life's tank; the died-as tank wins
    assert.equal(L.respawnAs({ lt: 'Vulture', ls: 1 }, 'Minigun').label, 'Respawn as Minigun');
    assert.equal(L.respawnAs({ lt: 'Vulture', ls: 1 }, 'Basic').label, 'Respawn as Vulture', 'died as Basic: the saved tank');
    assert.equal(L.lastTank({ lt: 'Minigun', ltu: 1 }), 'Last tank: Minigun');
    assert.equal(L.lastTank({ lt: 'Minigun' }), '', 'not below it: no button');
    assert.equal(L.lastTank({ lt: 'Minigun', ltu: 1 }, true), '', 'never in the tutorial');
    assert.deepEqual(L.statButtons({ ls: 1 }, 50).map(b => b.label), ['Same stats', 'Random']);
    assert.deepEqual(L.statButtons({}, 50).map(b => b.label), ['Random']);
    assert.deepEqual(L.statButtons({ ls: 1 }, 0), [], 'only while points are unspent');
    assert.equal(L.plural(1, 'point'), '1 point');
    assert.equal(L.plural(3, 'point'), '3 points');
    const mem = new Map(), st = { getItem: k => mem.get(k) || null, setItem: (k, v) => mem.set(k, v) };
    assert.equal(L.firstTime('kitX', st), true);
    assert.equal(L.firstTime('kitX', st), false);
    assert.match(L.TEAM_BANK_TIP, /^Team Bank: break its banner to own it\. Owners bank here safely; Vaults are open to everyone\.$/);
});

test('buttons: the client draws them, sends rb, phones can tap them', () => {
    const app = src('app.js'), cv = src('canvas.js'), g = src('global.js');
    assert.match(g, /lastTank: Region\(1\),\s*\n\s*statBtn: Region\(2\),/);
    assert.match(app, /type: "lastTank", index: 0/);
    assert.match(app, /type: "statBtn", index: b\.i/);
    assert.match(app, /royaleDomPlayBuild/);
    assert.match(cv, /this\.socket\.talk\('rb', 'tank'\)/);
    assert.match(cv, /this\.socket\.talk\('rb', this\.statBtnPressed === 0 \? 'stats' : 'random'\)/);
    assert.match(cv, /if \(global\.rbWantBuild\) \{ try \{ this\.socket\.talk\('rb', 'build'\)/);
    // Enter / Space = plain Respawn
    assert.match(cv, /global\.rbWantBuild = false;   \/\/ Enter \/ Space = plain Respawn/);
    // touch: clickables are tappable (touch.anyClickable walks them all)
    assert.match(src('touch.js'), /for \(const k in c\) \{/);
    // bug 1: stray keys after the death card reach the game
    assert.match(cv, /const stray = !t0 \|\| t0 === document\.body/);
    assert.match(app, /e\.preventDefault\(\); againAct\(\);/);
});

test('words: Team Bank, savings vs points lost, 1 point', async () => {
    const lay = ssrc('game/terrain/royaleLayout.js');
    assert.ok(!/Base Bank/.test(lay) && /"West Team Bank"/.test(lay));
    assert.ok(!/base bank/i.test(src('app.js').split('\n').filter(l => !/^\s*\/\//.test(l) && /"[^"]*base bank/i.test(l)).join('\n')));
    assert.match(ssrc('game/gamemodes/scripts/dig_royale.js'), /Nobody owns this Team Bank\./);
    const SL = await imp('scoreLogic.js');
    const d = SL.deathLine({ pts: { b: 900, k: 0, c: 0 }, dl: { p: 0 } }, 0, 1166);
    assert.equal(d.head + ' (' + d.lost + ')', 'Points: 900 (points lost: 0)');
    assert.match(d.savings, /older savings \(from earlier raids\) paid 1,166 gems/);
    assert.ok(!/banked gems are safe/.test(d.lost + d.savings), 'never "safe" next to "it cost your savings"');
    assert.equal(SL.deathLine({ pts: { b: 900, k: 0, c: 0 }, dl: { p: 0 } }, 0).lost, 'lost 0: banked gems are safe');
    const FS = await imp('firstSecondsLogic.js');
    assert.match(FS.introLines({ newRaid: true, points: 1 }).goal, /spend your 1 point\.$/);
    assert.match(FS.introLines({ newRaid: true, points: 50 }).goal, /spend your 50 points\.$/);
});

test('finale: results for everyone, the subtitle clears the title, progress', async () => {
    const f = src('raidFinale.js'), cv = src('canvas.js');
    assert.match(cv, /if \(global\.died && raidFinale\.active\(\) && !global\.finaleRespawn\) return;/);
    assert.match(f, /global\.finaleRespawn = true;\s*\n\s*try \{ global\.canvas\.respawn\(\); \}/);
    assert.match(f, /if \(S\.keep \|\| !S\.reveal \|\| now - S\.reveal < PODIUM_AT \+ 4000\) \{ D\.on = true;/);
    assert.ok(!/y \+ size \* 0\.68, fitSize/.test(f), 'no subtitle at the old fixed offset');
    // subY (pure math copied from the file): the line's top clears the title's ink
    const subY = (y, size, s2, k = 0.68) => y + Math.max(size * k, size * 0.62 + s2 * 0.55 + 8);
    for (const size of [36, 80, 150]) for (const s2 of [14, 30]) assert.ok(subY(0, size, s2) - s2 * 0.5 > size * 0.6, size + '/' + s2);
    const P = await imp('raidProgressLogic.js');
    P.addRank(12, 40); P.addRank(12, 25);
    const rk = { division: 3, name: 'Copper II', rp: 400, into: 60, size: 100 };
    let rows = P.rows({ rank: rk, rp: P.rankThisRaid(12), rpSeen: P.rankSeen(12), dust: 3.5, nu: { n: 'Neon Trail', p: 10 }, bestLife: 252, bestRaid: 9000 });
    assert.equal(rows[0].t, '+65 RP this raid. 40 RP to the next rank');
    assert.equal(rows[1].t, '6.5 gemdust to Neon Trail (3.5 / 10)');
    assert.equal(rows[2].t, 'Best life 4m 12s  ·  Best raid 9,000 pts');
    rows = P.rows({ guest: true, bestRaid: 0 });
    assert.match(rows[0].t, /^Sign up to earn rank points/);
    const mem = new Map(), st = { getItem: k => mem.get(k) || null, setItem: (k, v) => mem.set(k, String(v)) };
    assert.equal(P.noteRaid(3, 5000, st).isBest, true);
    assert.equal(P.noteRaid(4, 4000, st).best, 5000);
});

test('dust: pooled, capped, light profile, no per-frame allocation', () => {
    const m = src('mineDust.js');
    assert.match(m, /const CAP = 120;/);
    assert.match(m, /new Float32Array\(CAP\)/);
    const draw = m.slice(m.indexOf('export function draw'), m.indexOf('function popsOn'));
    assert.ok(!/new |\[\]|\{ *\w+:/.test(draw.replace(/\/\/.*$/gm, '')), 'draw() allocates nothing');
    assert.match(fs.readFileSync(path.join(REPO, 'scripts', 'build-client.js'), 'utf8'), /"client\/mineDust\.js",/);
    assert.match(src('socketinit.js'), /if \(kindF === "mchip"\) \{ try \{ mineDust\.burst\(fx\.x, fx\.y, m\[3\] \| 0, m\[4\] \| 0\); \}/);
    assert.match(src('raidHeat.js'), /mineDust\.draw\(c, px, py, ratio\);/);
});

(async () => {
    let failed = 0;
    for (const t of tests) {
        try { await t.fn(); console.log('ok   ' + t.name); }
        catch (e) { failed++; console.log('FAIL ' + t.name + '\n     ' + ((e && e.stack) || e).toString().split('\n').slice(0, 8).join('\n     ')); }
    }
    console.log(`\n${tests.length - failed}/${tests.length} passed`);
    process.exit(failed ? 1 : 0);
})();
