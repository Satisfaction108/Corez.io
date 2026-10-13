'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.join(__dirname, '..', '..');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-alwayson-test-'));
process.env.DATA_DIR = path.join(ROOT, 'data');
for (const k of ['DB_PATH', 'PUBLIC_HOST', 'PUBLIC_ORIGIN', 'ALLOWED_ORIGINS', 'ROYALE_DEBUG', 'ROYALE_AO_FIRST_MS']) delete process.env[k];
process.env.NODE_ENV = 'test';
process.env.ACCOUNTS_ENABLED = 'true';
process.env.SESSION_SECRET = 'alwayson-test-secret-0123456789-abcdefghij';
process.env.ROYALE_ALWAYS_ON = '1';
global.Config = { dig_royale: true };
global.gameManager = { port: 4999, terrainGrid: { circleRadius: 4192, rocks: new Map(), vaultSites: [{ x: 0, y: 0, r: 95 }, { x: 2000, y: 0, r: 95 }, { x: -2000, y: 0, r: 95 }], outpostSites: [], shopSites: [] } };

const accounts = require('../../server/accounts');
const S = require('../../server/game/terrain/aoSchedule.js');
const ao = require('../../server/game/terrain/alwaysOn.js');
const crowns = require('../../server/game/terrain/crowns.js');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const rd = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');

function lcg(seed) {
    let x = seed >>> 0;
    return () => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return x / 4294967296; };
}
let seq = 0;
function mkUser() {
    const r = accounts.users.create({ username: ('ao_' + (++seq) + '_' + Math.floor(Math.random() * 1e4)).slice(0, 16), recoveryHash: null });
    assert.ok(r.ok, JSON.stringify(r));
    return r.user;
}
const gid = (n) => (n.toString(16) + 'e'.repeat(32)).slice(0, 32);
const ds = () => require('../../server/accounts/dailyScores');

test('scheduler: no immediate repeats, every kind comes round, first six all different', () => {
    const rng = lcg(7);
    const hist = [];
    for (let i = 0; i < 3000; i++) hist.push(S.pickKind(hist, rng));
    for (let i = 1; i < hist.length; i++) assert.notEqual(hist[i], hist[i - 1], 'repeat at ' + i);
    assert.equal(new Set(hist.slice(0, 6)).size, 6, 'the first six are all different');
    for (let i = 0; i + 9 <= hist.length; i++) assert.equal(new Set(hist.slice(i, i + 9)).size, 6, 'window at ' + i);
    for (let i = 3; i < hist.length; i++) assert.ok(!hist.slice(i - 3, i).includes(hist[i]), 'not one of the last three at ' + i);
    for (const k of S.ORDER) assert.ok(hist.filter(x => x === k).length > 300, k + ' is picked fairly often');
    assert.equal(S.pickKind(['storm'], rng, ['storm']), 'storm', 'a single kind still works');
});

test('scheduler: spacing is 6 to 8 minutes, with a breather after a long event', () => {
    const rng = lcg(3);
    for (let i = 0; i < 500; i++) {
        const start = 1_000_000 + i * 1000, end = start + 240_000;
        const next = S.nextStartAt(start, end, rng);
        assert.ok(next - start >= S.GAP_MIN_MS && next - start <= S.GAP_MAX_MS, 'gap ' + (next - start));
        assert.ok(next - end >= S.BREATHER_MS, 'breather');
    }
    const late = S.nextStartAt(0, 9 * 60_000, () => 0);
    assert.equal(late, 9 * 60_000 + S.BREATHER_MS, 'an overlong event pushes the next one');
    assert.equal(S.WARN_MS, 60_000, 'announced a minute ahead');
});

test('scheduler: regions move away from the last one', () => {
    const R = 4192;
    const list = S.regions(R);
    assert.equal(list.length, 9);
    const rng = lcg(11);
    let last = null;
    for (let i = 0; i < 400; i++) {
        const r = S.pickRegion(list, last, rng, R);
        if (last) {
            assert.notEqual(r.id, last.id, 'never the same region twice');
            assert.ok(Math.hypot(r.x - last.x, r.y - last.y) >= R * 0.5, 'far from the last one');
        }
        last = r;
    }
    assert.equal(S.compassName(1500, 0, R), 'the East');
    assert.equal(S.compassName(0, 1500, R), 'the South');
    assert.equal(S.compassName(-1500, -1500, R), 'the Northwest');
    assert.equal(S.compassName(100, 50, R), 'the Centre');
});

test('scheduler: event size scales with the tanks in the world', () => {
    const a = S.scaleFor(2), b = S.scaleFor(14), c = S.scaleFor(80);
    assert.ok(a.stormR < b.stormR && b.stormR <= c.stormR);
    assert.ok(c.stormR <= 1900 && a.stormR >= 1250);
    assert.ok(a.coreGems < b.coreGems && c.coreGems <= 12000);
    assert.ok(a.rushR <= b.rushR && b.hillR >= a.hillR);
});

test('scoring: top three get the podium bonus, ties go to whoever got there first', () => {
    const m = new Map();
    m.set('a', { key: 'a', name: 'A', pts: 120, at: 5 });
    m.set('b', { key: 'b', name: 'B', pts: 300, at: 9 });
    m.set('c', { key: 'c', name: 'C', pts: 120, at: 2 });
    m.set('d', { key: 'd', name: 'D', pts: 10, at: 1 });
    m.set('z', { key: 'z', name: 'Z', pts: 0, at: 1 });
    m.set('x', { key: 'x', name: 'X', pts: 99999, at: 1, isBot: true });
    const aw = S.awardsFor(m);
    assert.deepEqual(aw.map(a => a.key), ['x', 'b', 'c', 'a', 'd']);
    assert.equal(aw[0].pts, S.ACTIVITY_CAP + S.PODIUM[0], 'activity is capped');
    assert.equal(aw[1].pts, 300 + S.PODIUM[1]);
    assert.equal(aw[2].pts, 120 + S.PODIUM[2]);
    assert.equal(aw[3].pts, 120, 'fourth gets no bonus');
    assert.equal(aw[3].place, 4);
    assert.deepEqual(S.placeOf(m, 'a'), { place: 4, pts: 120, of: 5 });
    assert.deepEqual(S.placeOf(m, 'z'), { place: 0, pts: 0, of: 5 });
    assert.equal(S.ordinal(1) + S.ordinal(2) + S.ordinal(3) + S.ordinal(11) + S.ordinal(22), '1st2nd3rd11th22nd');
});

test('day keys: the reset is at 00:00 UTC', () => {
    const t = Date.parse('2026-10-12T23:59:59.500Z');
    assert.equal(S.dayKey(t), '2026-10-12');
    assert.equal(S.dayKey(t + 600), '2026-10-13');
    assert.equal(S.nextResetAt(t), Date.parse('2026-10-13T00:00:00Z'));
    assert.equal(S.nextResetAt(Date.parse('2026-10-13T00:00:00Z')), Date.parse('2026-10-14T00:00:00Z'));
});

test('daily store: save, load, top and per world', () => {
    const D = ds();
    assert.ok(D.available());
    const day = '2026-10-01';
    D.save(day, 'w1', [
        { who: 'g:' + gid(1), name: 'Guest One', score: 900, playMs: 400_000, data: { banked: 800, kills: 1 } },
        { who: 'a:12', name: 'Acct', score: 1500, playMs: 100, data: { banked: 1500 } },
        { who: 'bad', name: 'Nope', score: 5 },
    ]);
    D.save(day, 'w2', [{ who: 'g:' + gid(2), name: 'Other World', score: 50 }]);
    const one = D.loadOne(day, 'g:' + gid(1));
    assert.equal(one.score, 900);
    assert.equal(one.data.banked, 800);
    assert.equal(D.loadOne(day, 'bad'), null);
    assert.deepEqual(D.loadWorld(day, 'w1').map(r => r.name), ['Acct', 'Guest One']);
    assert.deepEqual(D.top(day, 2).map(r => r.score), [1500, 900]);
    D.save(day, 'w1', [{ who: 'g:' + gid(1), name: 'Guest One', score: 1000, playMs: 500_000, data: { banked: 900 } }]);
    assert.equal(D.loadOne(day, 'g:' + gid(1)).score, 1000, 'an upsert keeps one row');
});

test('daily store: the top 3 are paid once, guests are paid when they sign up', () => {
    const D = ds();
    const day = '2026-10-02';
    const u1 = mkUser(), u2 = mkUser();
    const g = gid(9);
    D.save(day, 'w1', [
        { who: 'a:' + u1.id, name: u1.username, score: 5000, playMs: 900_000 },
        { who: 'g:' + g, name: 'Guesty', score: 4000, playMs: 900_000 },
        { who: 'a:' + u2.id, name: u2.username, score: 3000, playMs: 900_000 },
        { who: 'g:' + gid(10), name: 'Fourth', score: 100, playMs: 900_000 },
    ]);
    const before1 = accounts.users.byId(u1.id).dust_milli | 0;
    const r1 = D.settleDay(day, Date.now());
    assert.equal(r1.fresh, true);
    assert.deepEqual(r1.champs.map(c => c.place + ':' + c.name), ['1:' + u1.username, '2:Guesty', '3:' + u2.username]);
    assert.equal((accounts.users.byId(u1.id).dust_milli | 0) - before1, D.CHAMP_DUST_MILLI[0]);
    assert.equal(r1.champs[1].paid, false, 'a guest waits for sign up');
    const r2 = D.settleDay(day, Date.now());
    assert.equal(r2.fresh, false, 'a second world settling the same day changes nothing');
    assert.equal((accounts.users.byId(u1.id).dust_milli | 0) - before1, D.CHAMP_DUST_MILLI[0], 'paid once');
    assert.equal(D.owedFor(g), D.CHAMP_DUST_MILLI[1]);
    const u3 = mkUser();
    const b3 = accounts.users.byId(u3.id).dust_milli | 0;
    assert.equal(D.adoptGuest(g, u3.id), D.CHAMP_DUST_MILLI[1]);
    assert.equal((accounts.users.byId(u3.id).dust_milli | 0) - b3, D.CHAMP_DUST_MILLI[1]);
    assert.equal(D.adoptGuest(g, u3.id), 0, 'only once');
    assert.equal(D.owedFor(g), 0);
    const pl = D.dailyPlacement(day, Date.now());
    assert.ok(pl.some(p => p.userId === u1.id && p.place === 1 && p.rp > 0), 'daily placement RP for the winner');
    assert.equal(D.dailyPlacement(day, Date.now()).length, 0, 'the daily placement pays once');
});

test('daily store: scores survive a restart', () => {
    const D = ds();
    const day = '2026-10-03';
    D.save(day, 'w9', [{ who: 'g:' + gid(42), name: 'Stayer', score: 777, playMs: 1234, data: { banked: 700, evPts: 77, perks: { perks: { reach: 1 }, granted: 1, v: 3, pending: 0, offer: null } } }]);
    accounts.shutdown();
    assert.equal(D.available(), false, 'down while the server is down');
    assert.equal(accounts.initMain(), true, 'back up');
    const row = D.loadOne(day, 'g:' + gid(42));
    assert.equal(row.score, 777);
    assert.equal(row.data.evPts, 77);
    assert.equal(row.data.perks.perks.reach, 1, 'perk picks are kept for the day');
    assert.equal(row.playMs, 1234);
});

function fakeWorld() {
    const W = { added: [], toasts: [], announced: [], resets: [], rows: new Map(), ended: [], loaded: [] };
    W.bodies = [];
    W.mk = (id, x, y, bot) => {
        const b = { id, name: 'T' + id, x, y, team: 100 + id, isPlayer: !bot, isBot: !!bot, health: { max: 200, amount: 200 }, shield: null, velocity: { x: 0, y: 0 }, isDead: () => b.health.amount <= 0, carriedGems: 0 };
        W.bodies.push(b);
        return b;
    };
    ao.attach({
        fighters: () => W.bodies.filter(b => !b.isDead()),
        keyOf: (b) => 's:' + b.id,
        toast: (t) => W.toasts.push(t),
        feed: () => { },
        fxAt: () => { },
        announceAll: (kind, text) => W.announced.push(kind + ':' + text),
        addEvPts: (key, n, why) => W.added.push({ key, n, why }),
        onEventEnd: (ev, awards) => W.ended.push({ kind: ev.kind, awards }),
        loadRows: (rows) => W.loaded.push(...rows),
        saveRows: () => [...W.rows.values()],
        humanRows: () => [...W.rows.values()].map(r => ({ who: r.who, name: r.name, score: r.score })),
        dailyReset: (champs, oldDay, newDay) => W.resets.push({ champs, oldDay, newDay }),
    });
    return W;
}

test('runtime: a Storm Circle is announced, runs, scores, ends with a top 3 and crowns', () => {
    ao._reset();
    crowns.setAlwaysOn(true);
    crowns.newRaid();
    const W = fakeWorld();
    const inA = W.mk(1, 0, 0), inB = W.mk(2, 0, 0, true), out = W.mk(3, 3900, 0), ring = W.mk(4, 0, 0);
    let t = Date.parse('2026-10-05T12:00:00Z');
    ao.tick(t, W.bodies);
    const n0 = ao.nextEvent();
    assert.ok(n0, 'the first event is planned at boot');
    assert.equal(n0.startAt - t, S.FIRST_MS);
    ao.debugPlan('storm', 61, t);
    const n = ao.nextEvent();
    assert.equal(n.kind, 'storm');
    inA.x = n.x; inA.y = n.y; inB.x = n.x + 50; inB.y = n.y;
    const snapA = ao.snapshot(t);
    assert.equal(snapA.nx.k, 'storm');
    assert.equal(snapA.nx.a, 0, 'not announced 61 s out');
    t += 2000;
    ao.tick(t, W.bodies);
    assert.equal(ao.snapshot(t).nx.a, 1, 'announced a minute ahead');
    assert.ok(W.toasts.some(x => /Storm Circle starts in/.test(x)));
    assert.ok(ao.spawnZones().length >= 1, 'spawns keep clear of where it will be');
    t = n.startAt;
    ao.tick(t, W.bodies);
    const ev = ao.current();
    assert.ok(ev && ev.kind === 'storm', 'started');
    assert.ok(W.announced.some(x => /^aostart:STORM CIRCLE/.test(x)));
    ring.x = n.x + ev.data.R0 - 30; ring.y = n.y;
    out.x = n.x + ev.data.R0 + 400; out.y = n.y;
    for (let i = 0; i < 40; i++) { t += 1000; ao.tick(t, W.bodies); }
    assert.ok(ring.health.amount < 200, 'the ring hurts');
    assert.equal(out.health.amount, 200, 'outside the circle nothing changes');
    const st = ao.stormSnapshot(t);
    assert.ok(st.a && st.out === Math.round(ev.data.R0) && st.r < st.out, 'the client gets the scoped ring');
    const mid = ao.snapshot(t);
    assert.ok(mid.ev && mid.ev.top.length >= 2, 'a live top 3');
    assert.equal(ao.youFields('s:1', t).epl > 0, true);
    ao.onDeath(inB, inA);
    while (ao.current()) { t += 1000; ao.tick(t, W.bodies); }
    assert.equal(W.ended.length, 1);
    const aw = W.ended[0].awards;
    assert.equal(aw[0].key, 's:1', 'the kill inside put A first');
    assert.ok(W.added.find(a => a.key === 's:1').n >= S.PODIUM[0] + 300, 'survival bonus and the podium');
    assert.ok(inA.crowned, 'the winner wears a crown');
    assert.ok(!out.crowned, 'nobody outside got one');
    const res = ao.snapshot(t).res;
    assert.equal(res.n, 'Storm Circle');
    assert.ok(res.top.length >= 2 && res.top[0].n === 'T1');
    assert.equal(ao.youFields('s:1', t).rr.pl, 1);
    const nx = ao.nextEvent();
    assert.ok(nx && nx.kind !== 'storm', 'no immediate repeat');
    assert.ok(nx.startAt - ev.startAt >= S.GAP_MIN_MS && nx.startAt - ev.startAt <= S.GAP_MAX_MS, 'next one 6 to 8 minutes after the last start');
    assert.equal(ao.stormSnapshot(t), null, 'the ring is gone');
    assert.equal(inA._inStorm, false);
});

test('runtime: King of the Vault pays full alone, half when contested', () => {
    ao._reset();
    const W = fakeWorld();
    const a = W.mk(11, 0, 0), b = W.mk(12, 0, 0);
    let t = Date.parse('2026-10-05T13:00:00Z');
    ao.tick(t, W.bodies);
    const ev = ao.debugStart('hill', t);
    assert.equal(ev.kind, 'hill');
    a.x = ev.x + ev.padR + 60; a.y = ev.y;
    b.x = ev.x + ev.r + 300; b.y = ev.y;
    for (let i = 0; i < 10; i++) { t += 1000; ao.tick(t, W.bodies); }
    const p1 = S.placeOf(ev.scores, 's:11');
    assert.ok(p1.pts >= 80, 'holding alone scores');
    b.x = ev.x - ev.padR - 60;
    for (let i = 0; i < 10; i++) { t += 1000; ao.tick(t, W.bodies); }
    const p2 = S.placeOf(ev.scores, 's:11');
    assert.ok(p2.pts - p1.pts >= 40 && p2.pts - p1.pts <= 60, 'contested: half rate (' + (p2.pts - p1.pts) + ')');
    assert.ok(S.placeOf(ev.scores, 's:12').pts >= 40, 'the rival earns half too');
    assert.equal(ao.snapshot(t).ev.ct, 1);
    assert.ok((ao.snapshot(t).ev.ns || []).length === 2, 'the snapshot names who is on the hill');
    b.onVaultPad = true; b.x = ev.x; b.y = ev.y;
    for (let i = 0; i < 5; i++) { t += 1000; ao.tick(t, W.bodies); }
    assert.ok(S.placeOf(ev.scores, 's:11').pts - p2.pts >= 40, 'standing on the safe pad does not contest');
    ao.finish(t, true);
    assert.equal(W.ended[0].awards[0].key, 's:11');
});

test('runtime: the daily reset settles, crowns champions and survives a restart', () => {
    ao._reset();
    const W = fakeWorld();
    const g1 = 'g:' + gid(77), g2 = 'g:' + gid(78);
    W.rows.set(g1, { who: g1, name: 'Daily One', score: 2500, playMs: 600_000, data: { banked: 2500 } });
    W.rows.set(g2, { who: g2, name: 'Daily Two', score: 900, playMs: 600_000, data: { banked: 900 } });
    let t = Date.parse('2026-10-06T23:59:40Z');
    ao.tick(t, W.bodies);
    assert.equal(ao.dayNow(t), '2026-10-06');
    t += 11000;
    ao.tick(t, W.bodies);
    assert.equal(ds().loadOne('2026-10-06', g1).score, 2500, 'saved every few seconds');
    t = Date.parse('2026-10-07T00:00:01Z');
    ao.tick(t, W.bodies);
    assert.equal(W.resets.length, 1, 'midnight UTC resets the day');
    assert.equal(W.resets[0].oldDay, '2026-10-06');
    assert.equal(W.resets[0].newDay, '2026-10-07');
    assert.deepEqual(W.resets[0].champs.map(c => c.name), ['Daily One', 'Daily Two']);
    assert.ok(ao.champUntil(g1, t) === Date.parse('2026-10-08T00:00:00Z'), 'the champion flair lasts the next day');
    assert.equal(ao.champUntil('g:' + gid(79), t), 0);
    assert.deepEqual(ao.snapshot(t).ch.map(c => c.n), ['Daily One', 'Daily Two']);
    accounts.shutdown();
    assert.equal(accounts.initMain(), true);
    ao._reset();
    const W2 = fakeWorld();
    ds().save('2026-10-07', ao.worldId(), [{ who: g2, name: 'Daily Two', score: 40, playMs: 1000, data: { banked: 40 } }]);
    ao.tick(t + 1000, W2.bodies);
    assert.deepEqual(ao.snapshot(t + 1000).ch.map(c => c.n), ['Daily One', 'Daily Two'], "yesterday's champions come back after a restart");
    assert.deepEqual(W2.loaded.map(r => r.who), [g2], "today's rows for this world load at boot");
    const r = ao.doReset(t + 2000, true);
    assert.equal(r.oldDay, '2026-10-07');
    assert.equal(r.day, '2026-10-08', 'a forced reset moves to the next day');
});

test('wiring: dig_royale, sockets, client and build know Always-On', () => {
    const dr = rd('server/game/gamemodes/scripts/dig_royale.js');
    assert.ok(dr.includes("if (AO()) return;"), 'endRaid is a no-op');
    assert.ok(dr.includes("if (!ao) guard('storm'"), 'no global storm');
    assert.ok(dr.includes("guard('always on', () => alwaysOn.tick(t, fighters))"));
    assert.ok(dr.includes('(s.evPts | 0)'), 'event points are in the daily score');
    const sk = rd('server/game/network/sockets.js');
    assert.ok(sk.includes('what === "event" || what === "aostate" || what === "dayreset"'));
    const app = rd('public/client/app.js');
    assert.ok(app.includes("import * as aoHud from './alwaysOn.js';"));
    assert.ok(app.includes('aoHud.drawPanel('));
    assert.ok(app.includes('aoHud.drawResult('));
    const si = rd('public/client/socketinit.js');
    assert.ok(si.includes('if (aoHud.on()) break;'), 'no raid-end finale in Always-On');
    const bc = rd('scripts/build-client.js');
    const hot = bc.slice(bc.indexOf('const HOT'), bc.indexOf(']);', bc.indexOf('const HOT')));
    assert.ok(hot.includes('"client/alwaysOn.js"') && hot.trim().endsWith('"client/funnel.js",'), 'HOT list, funnel last');
    for (const f of ['server/game/terrain/alwaysOn.js', 'server/game/terrain/aoSchedule.js', 'server/accounts/dailyScores.js', 'public/client/alwaysOn.js', 'server/accounts/routes/champions.js']) {
        const src = rd(f);
        assert.ok(!/\/\*|(^|[^:'"])\/\/(?!\/)/m.test(src.replace(/'[^'\n]*'|"[^"\n]*"|`[^`]*`/g, '""')), f + ' has no comments');
        assert.ok(!/\u2014|\u2013/.test(src), f + ' has no dashes');
    }
});

(async () => {
    const quietLog = console.log;
    console.log = (...a) => { if (!String(a[0]).startsWith('[accounts]')) quietLog(...a); };
    assert.equal(accounts.initMain(), true, 'initMain');
    let failed = 0;
    for (const t of tests) {
        try { await t.fn(); quietLog('ok   ' + t.name); }
        catch (e) { failed++; quietLog('FAIL ' + t.name + '\n     ' + String(e && e.stack || e).split('\n').slice(0, 8).join('\n     ')); }
    }
    try { accounts.shutdown(); } catch (e) { }
    quietLog(failed ? `${failed} of ${tests.length} failed` : `all ${tests.length} passed`);
    if (!failed) fs.rmSync(ROOT, { recursive: true, force: true });
    process.exit(failed ? 1 : 0);
})();
