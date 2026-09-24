// Ranked + gemdust tests (Phase 2): node scripts/test/ranked.test.js
//
//   maths    ranked.js / dust.js / dustHooks.js pure helpers: floors, fares,
//            the life cap, path independence of the curve, placement,
//            Legend #N, kill filters, dust conservation, the soft cap
//   database rankStore + dust on a throwaway database (open/settle once,
//            placement flow, raid placement bonus, crash close, Legend #N)
//   hooks    rankHooks + dustHooks driven through a fake raid (life start,
//            resume, kill filters, death, raid end, disconnect, shutdown)
//   e2e      a local server (ROYALE_DEBUG=1 ACCOUNTS_ALLOW_DEBUG=1) played
//            over the game socket with DBG commands; RANKED_E2E=0 skips it
// RANKED_ONLY=<prefix> runs only the tests whose name starts with it.
//
// Data goes under $DATA_DIR if set (point it at a scratch directory),
// otherwise the OS temp dir; it is removed when everything passes.
'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const REPO = path.join(__dirname, '..', '..');
const ROOT = process.env.DATA_DIR
    ? path.join(process.env.DATA_DIR, `ranked-test-${process.pid}-${Date.now()}`)
    : fs.mkdtempSync(path.join(os.tmpdir(), 'dw-ranked-test-'));
const DATA_DIR = path.join(ROOT, 'data');
const E2E_DATA_DIR = path.join(ROOT, 'e2e-data');
const SECRET = 'ranked-test-secret-0123456789-abcdefghijklmnop';

// ---- environment (before the accounts modules are loaded) ----
process.env.DATA_DIR = DATA_DIR;
delete process.env.DB_PATH;
delete process.env.PUBLIC_HOST;
delete process.env.PUBLIC_ORIGIN;
delete process.env.ALLOWED_ORIGINS;
delete process.env.ROYALE_DEBUG;
delete process.env.ACCOUNTS_ALLOW_DEBUG;
process.env.NODE_ENV = 'test';
process.env.ACCOUNTS_ENABLED = 'true';
process.env.SESSION_SECRET = SECRET;

const R = require('../../shared/ranks.js');
const ranked = require('../../server/accounts/ranked');
const dust = require('../../server/accounts/dust');
const accounts = require('../../server/accounts');
const rankStore = require('../../server/accounts/rankStore');
const dustHooks = require('../../server/accounts/game/dustHooks');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const DAY = 24 * 60 * 60 * 1000;

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// deterministic PRNG for the randomised checks
function rng(seed) {
    let s = seed >>> 0;
    return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

// ===================================================================
// Maths
// ===================================================================

test('curve: rates, boundaries and whole RP', () => {
    assert.equal(ranked.curveGain(0, 11), 0);
    assert.equal(ranked.curveGain(0, 12), 1);
    assert.equal(ranked.curveGain(0, 1500), 125);
    assert.equal(ranked.curveGain(1500, 24), 1);
    assert.equal(ranked.curveGain(0, 4000), 229);              // 125 + 2500/24
    assert.equal(ranked.curveGain(4000, 4000), 83);            // 4000/48
    assert.equal(ranked.curveGain(8000, 8000), 83);            // 8000/96
    assert.equal(ranked.curveGain(16000, 1920), 10);           // 1920/192
    assert.equal(ranked.curveGain(0, -50), 0);
    // agrees with the shared float curve
    for (const p of [0, 7, 1499, 1500, 3999, 4001, 12345, 40000]) assert.equal(Math.floor(ranked.curveUnits(p) / 192), Math.floor(R.curve(p) + 1e-9));
});

test('curve: splitting a raid into lives changes nothing (path independence)', () => {
    const rand = rng(7);
    for (let trial = 0; trial < 500; trial++) {
        const total = Math.floor(rand() * 30000);
        let left = total, at = 0, sum = 0;
        while (left > 0) {
            const piece = Math.min(left, 1 + Math.floor(rand() * 2500));
            sum += ranked.curveGain(at, piece);
            at += piece;
            left -= piece;
        }
        assert.equal(sum, ranked.curveGain(0, total), 'total ' + total);
    }
});

test('life cap: 200 RP per life, capped flag', () => {
    assert.equal(ranked.lifeGain(0, 100000), R.LIFE_CAP);
    assert.equal(ranked.lifeGain(0, 1500), 125);
    const r = ranked.settle({ rp: 1000, ranked: true }, { basis: 9000, countedBefore: 0, durationMs: 600000, reason: 'death' });
    assert.equal(r.gain, 200);
    assert.ok(r.capped && r.rawGain > 200);
    assert.equal(r.delta, 200);
});

test('fares: from Platinum only; short lives, shutdown, crash, raid end and spawn kills pay none; disconnects do', () => {
    const f = (division, extra = {}) => ranked.fareFor({ division, durationMs: 60000, reason: 'death', ...extra });
    for (let i = 0; i < 9; i++) assert.equal(f(i), 0, R.nameOf(i));
    assert.deepEqual([9, 10, 11, 12, 13, 14, 15, 16, 17, 18].map(i => f(i)), [3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    assert.equal(f(12, { durationMs: 29999 }), 0);
    assert.equal(f(12, { durationMs: 30000 }), 6);
    for (const reason of ['shutdown', 'crash', 'raidend']) assert.equal(f(12, { reason }), 0, reason);
    assert.equal(f(12, { reason: 'disconnect' }), 6);
    assert.equal(f(12, { noFare: true }), 0);
    assert.equal(f(12, { placement: true }), 0);
});

test('floors: never below the start of the current division', () => {
    assert.deepEqual(ranked.applyDelta(2640, 0, 3), { rp: 2640, division: 9, delta: 0 });
    assert.deepEqual(ranked.applyDelta(2642, 0, 3), { rp: 2640, division: 9, delta: -2 });
    assert.deepEqual(ranked.applyDelta(3000, 1, 3), { rp: 2998, division: 9, delta: -2 });
    assert.deepEqual(ranked.applyDelta(3190, 20, 3), { rp: 3207, division: 10, delta: 17 });
    assert.deepEqual(ranked.applyDelta(12840, 0, 12), { rp: 12840, division: 18, delta: 0 });
    // a whole losing streak stops at the floor
    let rp = 4600;
    for (let i = 0; i < 50; i++) rp = ranked.applyDelta(rp, 0, ranked.fareFor({ division: R.divisionOf(rp), durationMs: 60000, reason: 'death' })).rp;
    assert.equal(rp, R.floorOf(12));
    const r = ranked.settle({ rp: 2641, ranked: true }, { basis: 0, countedBefore: 0, durationMs: 60000, reason: 'death' });
    assert.equal(r.fare, 3);
    assert.equal(r.delta, -1);
    assert.equal(r.rp, 2640);
});

test('placement: counted lives, start division from the best two, RP kept inside it', () => {
    assert.deepEqual([0, 299, 300, 599, 600, 899, 900, 1299, 1300, 1799, 1800, 2499, 2500, 99999].map(R.placementStart),
        [0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6]);
    let u = { rp: 0, ranked: false, placementLives: 0, placementBasis: [], placementGain: 0 };
    const step = (life) => {
        const r = ranked.settle(u, { countedBefore: 0, reason: 'death', noFare: false, ...life });
        u = { rp: r.rp, ranked: r.ranked, placementLives: r.placementLives, placementBasis: r.placementBasis, placementGain: r.placementGain };
        return r;
    };
    // < 60 s and no points: does not count
    let r = step({ basis: 0, durationMs: 59000 });
    assert.equal(r.counted, false);
    assert.deepEqual(r.placement, { inPlacement: true, lives: 0, of: 3, finished: false, startDivision: null });
    // >= 60 s counts even with no points; points count even when short
    r = step({ basis: 0, durationMs: 61000 });
    assert.equal(r.placement.lives, 1);
    r = step({ basis: 1000, durationMs: 20000 });
    assert.equal(r.placement.lives, 2);
    assert.equal(r.fare, 0);
    assert.equal(r.delta, ranked.lifeGain(0, 1000));
    r = step({ basis: 950, durationMs: 300000 });
    assert.equal(r.placement.finished, true);
    assert.equal(r.placement.inPlacement, false);
    // best two: 1000 and 950 -> 975 -> Silver I
    assert.equal(r.placement.startDivision, 3);
    assert.equal(r.division, 3);
    assert.equal(r.rp, R.floorOf(3) + Math.min(u.placementGain, R.DIVISIONS[3].size - 1));
    assert.equal(r.ranked, true);
    // a huge placement gain never skips past the start division
    const f = ranked.placementFinish([5000, 5000, 5000], 9999);
    assert.equal(f.division, 6);
    assert.equal(f.rp, R.floorOf(6) + R.DIVISIONS[6].size - 1);
});

test('raid placement bonus: eligibility and amounts', () => {
    const ok = { rows: 6, score: 100, raidMs: 5 * 60 * 1000 };
    assert.deepEqual(ranked.placementBonus({ ...ok, place: 1 }), { eligible: true, rp: 40, dustMilli: 2000 });
    assert.deepEqual(ranked.placementBonus({ ...ok, place: 3 }), { eligible: true, rp: 22, dustMilli: 500 });
    assert.equal(ranked.placementBonus({ ...ok, place: 4 }).eligible, false);           // max(3, ceil(6/2)) = 3
    assert.deepEqual(ranked.placementBonus({ ...ok, rows: 8, place: 4 }), { eligible: true, rp: 15, dustMilli: 0 });
    assert.deepEqual(ranked.placementBonus({ ...ok, rows: 40, place: 10 }), { eligible: true, rp: 8, dustMilli: 0 });
    assert.equal(ranked.placementBonus({ ...ok, rows: 40, place: 11 }).eligible, false);
    assert.equal(ranked.placementBonus({ ...ok, place: 1, score: 0 }).eligible, false);
    assert.equal(ranked.placementBonus({ ...ok, place: 1, raidMs: 299999 }).eligible, false);
    assert.equal(ranked.placementBonus({ rows: 2, score: 5, raidMs: 1e7, place: 2 }).eligible, true);  // small raids still pay the top 3
});

test('kill filters: bot half, player full, 3rd kill of one account, spawn kills', () => {
    const k = (o) => ranked.killFilter({ victimIsBot: false, victimAliveMs: 60000, priorKills: 0, pts: 250, ...o });
    assert.deepEqual(k({ victimIsBot: true }), { discount: 125, dustMilli: 125, spawnKill: false, filtered: false });
    assert.deepEqual(k({ victimIsBot: true, pts: 201 }).discount, 101);
    assert.deepEqual(k({}), { discount: 0, dustMilli: 250, spawnKill: false, filtered: false });
    assert.deepEqual(k({ priorKills: 1 }).dustMilli, 250);
    assert.deepEqual(k({ priorKills: 2 }), { discount: 250, dustMilli: 0, spawnKill: false, filtered: true });
    assert.deepEqual(k({ victimAliveMs: 14999 }), { discount: 250, dustMilli: 0, spawnKill: true, filtered: true });
    assert.deepEqual(k({ victimAliveMs: 15000 }).filtered, false);
    assert.deepEqual(k({ victimIsBot: true, victimAliveMs: 3000 }).dustMilli, 0);
});

test('Legend #N: more RP first, ties to whoever got there first, then the older account', () => {
    const rows = [
        { id: 1, rp: 13000, legendAt: 500 }, { id: 2, rp: 14000, legendAt: 900 },
        { id: 3, rp: 13000, legendAt: 400 }, { id: 4, rp: 13000, legendAt: 400 }, { id: 5, rp: 12840, legendAt: 100 },
    ];
    assert.deepEqual(ranked.legendOrder(rows).map(r => r.id), [2, 3, 4, 1, 5]);
    assert.equal(ranked.legendNo(rows, 2), 1);
    assert.equal(ranked.legendNo(rows, 4), 3);
    assert.equal(ranked.legendNo(rows, 5), 5);
    assert.equal(ranked.legendNo(rows, 99), 0);
});

test('RK parts: the gain split by source sums exactly', () => {
    const rand = rng(11);
    for (let i = 0; i < 300; i++) {
        const gain = Math.floor(rand() * 200);
        const src = [['Banked', Math.floor(rand() * 900)], ['Kills', Math.floor(rand() * 600)], ['Carried', 0], ['Bonus', Math.floor(rand() * 50)]];
        const parts = ranked.splitParts(gain, src);
        const sum = parts.reduce((a, [, v]) => a + v, 0);
        const anyPts = src.some(([, p]) => p > 0);
        assert.equal(sum, anyPts ? gain : 0);
        assert.ok(parts.every(([, v]) => v > 0));
    }
});

test('dust: proportional banking over many chunks sums exactly (every efficiency)', () => {
    const rand = rng(3);
    for (let trial = 0; trial < 400; trial++) {
        const D = Math.floor(rand() * 200000);
        let carried = 1 + Math.floor(rand() * 4000), dustLeft = D, moved = 0;
        const eff = [1, 0.8, 0.7][trial % 3];
        let remK = 0, credited = 0;
        while (carried > 0) {
            const chunk = Math.min(carried, 1 + Math.floor(rand() * 40));
            const m = dustHooks.bankShare(dustLeft, chunk, carried);
            dustLeft -= m; moved += m; carried -= chunk;
            const e = dustHooks.effCredit(m, eff, remK);
            remK = e.remK; credited += e.credit;
        }
        assert.equal(moved, D, 'all dust leaves with the last gem');
        assert.equal(dustLeft, 0);
        assert.equal(credited, Math.floor(D * Math.round(eff * 1000) / 1000), 'eff ' + eff + ' D ' + D);
    }
    // a partial bank leaves the right share behind
    assert.equal(dustHooks.bankShare(1000, 250, 1000), 250);
    assert.equal(dustHooks.bankShare(1000, 0, 1000), 0);
    assert.equal(dustHooks.bankShare(0, 10, 100), 0);
});

test('dust: insurance takes exactly 25%; the death split sums exactly, remainder on the largest', () => {
    const rand = rng(5);
    for (let trial = 0; trial < 400; trial++) {
        const D = Math.floor(rand() * 100000);
        const ins = dustHooks.insuranceShare(D);
        assert.equal(ins, Math.floor(D / 4));
        const values = Array.from({ length: 1 + Math.floor(rand() * 30) }, () => Math.floor(rand() * 160));
        const shares = dustHooks.splitDeath(D - ins, values);
        const sum = shares.reduce((a, b) => a + b, 0);
        assert.equal(sum, values.some(v => v > 0) ? D - ins : 0);
        values.forEach((v, i) => { if (!(v > 0)) assert.equal(shares[i], 0); });
    }
    assert.deepEqual(dustHooks.splitDeath(10, [15, 15, 30]), [2, 2, 6]);
    assert.deepEqual(dustHooks.splitDeath(0, [15, 30]), [0, 0]);
});

test('dust: daily soft cap pays 25% past the cap; exact thousandths', () => {
    assert.deepEqual(dust.softCap(0, 100), { creditK: 100000, earned: 100 });
    assert.deepEqual(dust.softCap(49990, 100), { creditK: 10 * 1000 + 90 * 250, earned: 50090 });
    assert.deepEqual(dust.softCap(60000, 1000), { creditK: 250000, earned: 61000 });
});

// ===================================================================
// Database
// ===================================================================

let seq = 0;
function mkUser(prefix = 'rk') {
    const r = accounts.users.create({ username: (prefix + '_' + (++seq) + '_' + Math.floor(Math.random() * 1e4)).slice(0, 16), recoveryHash: null });
    assert.ok(r.ok, JSON.stringify(r));
    return r.user;
}
const D = () => accounts.db.handle();
const userRow = id => D().get('SELECT * FROM users WHERE id = ?', id);
let lifeSeq = 0;
function open(userId, extra = {}) {
    const lifeId = 'test-life-' + (++lifeSeq);
    rankStore.openLife({ lifeId, userId, raidKey: 'test:1', serverId: 'test', startedAt: Date.now() - 60000, basisStart: 0, raidPtsStart: 0, ...extra });
    return lifeId;
}
function settle(lifeId, userId, extra = {}) {
    return rankStore.settleLife({ lifeId, userId, reason: 'death', basis: 0, countedBefore: 0, durationMs: 60000, noFare: false, kills: 0, botKills: 0, sources: [], dust: { lifeMilli: 0, balanceMilli: 0 }, ...extra });
}

test('db: a life opens once and settles exactly once', () => {
    const u = mkUser();
    const lifeId = open(u.id);
    const row = D().get('SELECT * FROM rank_lives WHERE life_id = ?', lifeId);
    assert.equal(row.ended_at, null);
    assert.equal(row.placement, 1);
    const rk = settle(lifeId, u.id, { basis: 600, kills: 2, botKills: 1, sources: [['Banked', 400], ['Kills', 200]] });
    assert.equal(rk.v, 1);
    assert.equal(rk.guest, false);
    assert.equal(rk.reason, 'death');
    assert.equal(rk.basis, 600);
    assert.equal(rk.gain, ranked.lifeGain(0, 600));
    assert.equal(rk.delta, rk.gain);
    assert.deepEqual(rk.placement, { inPlacement: true, lives: 1, of: 3, finished: false, startDivision: null });
    assert.equal(rk.before.division, null);
    assert.equal(rk.after.placement.lives, 1);
    assert.equal(rk.parts.reduce((a, [, v]) => a + v, 0), rk.gain);
    assert.deepEqual(Object.keys(rk).sort(), ['after', 'basis', 'before', 'capped', 'delta', 'dust', 'fare', 'gain', 'guest', 'legendNo', 'parts', 'placement', 'rankDown', 'rankUp', 'reason', 'tierUp', 'v'].sort());
    assert.equal(settle(lifeId, u.id, { basis: 5000 }), null, 'second settle is a no-op');
    const after = D().get('SELECT * FROM rank_lives WHERE life_id = ?', lifeId);
    assert.equal(after.end_reason, 'death');
    assert.equal(after.basis, 600);
    assert.equal(after.kills, 2);
    const st = D().get('SELECT * FROM user_stats WHERE user_id = ?', u.id);
    assert.equal(st.lives, 1);
    assert.equal(st.deaths, 1);
    assert.equal(st.best_life, 600);
});

test('db: three placement lives reveal the start division; RankSnap and /api/me shape', () => {
    const u = mkUser();
    const bases = [1000, 200, 950];
    let rk;
    for (const b of bases) rk = settle(open(u.id), u.id, { basis: b, countedBefore: 0 });
    assert.equal(rk.placement.finished, true);
    assert.equal(rk.rankUp, true);
    assert.equal(rk.after.division, 3);
    const row = userRow(u.id);
    assert.ok(row.ranked_at > 0);
    assert.equal(row.division, 3);
    assert.equal(row.placement_lives, 3);
    const gain = bases.reduce((a, b) => a + ranked.lifeGain(0, b), 0);
    assert.equal(row.rp, R.floorOf(3) + Math.min(gain, R.DIVISIONS[3].size - 1));
    const snap = rankStore.snapshot(row);
    assert.deepEqual(Object.keys(snap).sort(), ['division', 'into', 'legendNo', 'name', 'peak', 'pct', 'placement', 'rp', 'size', 'tier'].sort());
    assert.equal(snap.name, 'Silver I');
    assert.equal(snap.tier, 'silver');
    assert.deepEqual(snap.placement, { done: true, lives: 3, of: 3 });
    assert.deepEqual(snap.peak, { division: 3, name: 'Silver I' });
    assert.equal(rankStore.codeOf(row), 4);
    assert.deepEqual(accounts.users.toPublic(row).rank, snap);
    assert.equal(rankStore.codeOf(userRow(mkUser().id)), R.CODE_PLACEMENT);
});

test('db: Platinum fare with the division floor; rank-up and tier-up flags', () => {
    const u = mkUser();
    rankStore.debugSetRp(u.id, 2641);
    let rk = settle(open(u.id), u.id, { basis: 0, durationMs: 45000 });
    assert.equal(rk.fare, 3);
    assert.equal(rk.delta, -1);
    assert.equal(rk.after.rp, 2640);
    assert.equal(rk.rankDown, false);
    rk = settle(open(u.id), u.id, { basis: 0, durationMs: 20000 });
    assert.equal(rk.fare, 0, 'short life');
    rankStore.debugSetRp(u.id, 2630);
    rk = settle(open(u.id), u.id, { basis: 400, durationMs: 45000 });
    assert.equal(rk.before.division, 8);
    assert.equal(rk.fare, 0, 'Gold III pays no fare');
    assert.equal(rk.after.division, 9);
    assert.equal(rk.rankUp, true);
    assert.equal(rk.tierUp, true);
    assert.equal(userRow(u.id).peak_division, 9);
    rk = settle(open(u.id), u.id, { basis: 0, durationMs: 45000, reason: 'shutdown' });
    assert.equal(rk.fare, 0, 'shutdown');
    rk = settle(open(u.id), u.id, { basis: 0, durationMs: 45000, reason: 'disconnect' });
    assert.equal(rk.fare, 3, 'disconnect pays');
    rk = settle(open(u.id), u.id, { basis: 0, durationMs: 45000, noFare: true });
    assert.equal(rk.fare, 0, 'spawn-killed life');
});

test('db: raid placement bonus, idempotent per raid; exempt dust with a ledger row; stats', () => {
    const u = mkUser();
    rankStore.debugSetRp(u.id, 700);
    const res = rankStore.applyRaidPlacement({ raidKey: 'r:1', userId: u.id, place: 1, rows: 6, score: 900, raidMs: 6 * 60000 });
    assert.equal(res.bonusRP, 40);
    assert.equal(res.bonusDustMilli, 2000);
    assert.equal(res.after.rp, 740);
    assert.equal(res.rankUp, true);                 // Bronze III -> Silver II? 700 is Silver I (480..720), 740 Silver II
    assert.equal(res.after.division, 4);
    assert.equal(res.balanceMilli, 2000);
    assert.equal(rankStore.applyRaidPlacement({ raidKey: 'r:1', userId: u.id, place: 1, rows: 6, score: 900, raidMs: 6 * 60000 }), null);
    assert.equal(userRow(u.id).dust_milli, 2000);
    const led = D().all('SELECT * FROM dust_ledger WHERE user_id = ?', u.id);
    assert.deepEqual(led.map(r => [r.kind, r.delta_milli, r.balance_milli, r.ref]), [['placement', 2000, 2000, 'r:1']]);
    const st = D().get('SELECT raids, raid_wins, top3 FROM user_stats WHERE user_id = ?', u.id);
    assert.deepEqual(st, { raids: 1, raid_wins: 1, top3: 1 });
    // not eligible: no bonus, no win, still a raid
    const res2 = rankStore.applyRaidPlacement({ raidKey: 'r:2', userId: u.id, place: 1, rows: 6, score: 900, raidMs: 60000 });
    assert.equal(res2.bonusRP, 0);
    assert.deepEqual(D().get('SELECT raids, raid_wins FROM user_stats WHERE user_id = ?', u.id), { raids: 2, raid_wins: 1 });
    // in placement the bonus RP waits in placement_gain
    const p = mkUser();
    rankStore.applyRaidPlacement({ raidKey: 'r:1', userId: p.id, place: 2, rows: 6, score: 500, raidMs: 6 * 60000 });
    assert.equal(userRow(p.id).placement_gain, 30);
    assert.equal(userRow(p.id).rp, 0);
});

test('db: a crash leaves lives open; boot closes them with delta 0', () => {
    const u = mkUser();
    rankStore.debugSetRp(u.id, 3000);
    const lifeId = open(u.id);
    assert.ok(rankStore.closeOrphans() >= 1);
    const row = D().get('SELECT * FROM rank_lives WHERE life_id = ?', lifeId);
    assert.equal(row.end_reason, 'crash');
    assert.equal(row.delta, 0);
    assert.equal(row.rp_after, row.rp_before);
    assert.equal(userRow(u.id).rp, 3000);
    assert.equal(settle(lifeId, u.id, { basis: 999 }), null);
});

test('db: Legend #N from the database matches the pure ordering; cached 60 s', () => {
    const now = Date.now();
    const made = [[13500, now - 5000], [14000, now - 1000], [13500, now - 9000], [12840, now - 1]].map(([rp, at]) => {
        const u = mkUser('lg');
        rankStore.debugSetRp(u.id, rp);
        D().run('UPDATE users SET legend_at = ? WHERE id = ?', at, u.id);
        return { id: u.id, rp, legendAt: at };
    });
    const pure = made.map(m => ranked.legendNo(made, m.id));
    const others = D().get('SELECT count(*) AS n FROM users WHERE legend_at IS NOT NULL').n - made.length;
    const fromDb = made.map(m => rankStore.legendRank(userRow(m.id), { fresh: true }) - others);
    assert.deepEqual(fromDb, pure);
    assert.deepEqual(pure, [3, 1, 2, 4]);
    const snap = rankStore.snapshot(userRow(made[1].id));
    assert.equal(snap.division, 18);
    assert.equal(snap.name, 'Legend');
    assert.equal(snap.pct, 1);
    // cached: a new, better Legend does not move a cached #N until it expires
    const top = mkUser('lg');
    rankStore.debugSetRp(top.id, 20000);
    assert.equal(rankStore.legendRank(userRow(made[3].id)), fromDb[3] + others);
    assert.equal(rankStore.legendRank(userRow(made[3].id), { fresh: true }), fromDb[3] + others + 1);
});

test('db: dust flush writes balances, ledger rows and stats in one transaction', () => {
    const a = mkUser(), b = mkUser();
    const day = dust.dayOf(Date.now());
    const res = dust.flush([
        { userId: a.id, gems: 1234, kill: 250, day, earned: 1484, gemsBanked: 900, ref: 'x:1' },
        { userId: b.id, gems: 0, kill: 125, day, earned: 125, gemsBanked: 0, ref: 'x:1' },
    ]);
    assert.equal(res.get(a.id), 1484);
    assert.equal(res.get(b.id), 125);
    assert.deepEqual(D().all('SELECT kind, delta_milli, balance_milli FROM dust_ledger WHERE user_id = ? ORDER BY id', a.id).map(r => [r.kind, r.delta_milli, r.balance_milli]),
        [['gems', 1234, 1234], ['kill', 250, 1484]]);
    const ua = userRow(a.id);
    assert.deepEqual([ua.dust_milli, ua.earn_day, ua.earn_day_milli], [1484, day, 1484]);
    assert.deepEqual(D().get('SELECT gems_banked, dust_earned_milli FROM user_stats WHERE user_id = ?', a.id), { gems_banked: 900, dust_earned_milli: 1484 });
    const sum = D().get('SELECT sum(delta_milli) AS s FROM dust_ledger WHERE user_id = ?', a.id).s;
    assert.equal(sum, ua.dust_milli);
});

// ===================================================================
// Hooks harness: rankHooks + dustHooks on a fake raid
// ===================================================================

let rankHooks = null, bridge = null;
const H = { stats: new Map(), clients: [], raidId: 1, order: null };
let sockSeq = 0;
function mkSocket(user) {
    const s = { id: 'sock' + (++sockSeq), account: user ? { id: user.id, publicId: user.public_id, username: user.username } : null, packets: [], terminated: false, player: { body: null } };
    s.talk = (type, ...args) => s.packets.push([type, ...args]);
    return s;
}
function mkBody(socket, extra = {}) {
    const b = { id: 1000 + (++sockSeq), socket, rankCode: 0, dustCarried: 0, carriedGems: 0, isDead: () => false, ...extra };
    if (socket) socket.player.body = b;
    return b;
}
function mkStat(key) {
    const s = { key, banked: 0, kills: 0, killPts: 0, extra: 0, revengeBonus: 0, carried: 0, alive: true };
    H.stats.set(key, s);
    return s;
}
const packets = (sock, type) => sock.packets.filter(p => p[0] === type);
const json = p => JSON.parse(p[1]);

test('hooks: harness attaches', () => {
    global.Config = { dig_royale: true };
    rankHooks = require('../../server/accounts/game/rankHooks');
    bridge = require('../../server/accounts/game/bridge');
    rankHooks.attach({
        stats: () => H.stats, clients: () => H.clients, raidId: () => H.raidId,
        board: () => H.order || [...H.stats.values()].map(s => ({ s, score: (s.banked | 0) + (s.killPts | 0) })).sort((a, b) => b.score - a.score),
        resumeMs: 300, serverId: 'harness',
    });
    assert.equal(bridge.rankedOn(), true);
    assert.equal(bridge.debugOn(), false);
});

test('hooks: life start opens a row; a resume keeps the same life', () => {
    const u = mkUser('hk');
    const sock = mkSocket(u);
    H.clients.push(sock);
    const body = mkBody(sock, { rankCode: 20 });
    const s = mkStat('s:' + sock.id);
    rankHooks.lifeStart(body, s);
    assert.equal(s.lifeOpen, true);
    const first = s.lifeId;
    assert.equal(D().get('SELECT count(*) AS n FROM rank_lives WHERE user_id = ? AND ended_at IS NULL', u.id).n, 1);
    assert.equal(s.rankCode, 20);
    // the socket drops and comes back (claimResume re-keys the stat): same life
    const again = mkSocket(u);
    H.clients.splice(H.clients.indexOf(sock), 1, again);
    H.stats.delete(s.key); s.key = 's:' + again.id; H.stats.set(s.key, s);
    rankHooks.lifeStart(mkBody(again, { rankCode: 20 }), s);
    assert.equal(s.lifeId, first);
    assert.equal(D().get('SELECT count(*) AS n FROM rank_lives WHERE user_id = ?', u.id).n, 1);
    H.clients.splice(H.clients.indexOf(again), 1);
    H.stats.delete(s.key);
});

test('hooks: kill filters, kill dust (DU kind 3), death RK with the right basis; settled once', async () => {
    const killerU = mkUser('hk'), victimU = mkUser('hk');
    const ks = mkSocket(killerU), vsock = mkSocket(victimU);
    H.clients.push(ks, vsock);
    const kb = mkBody(ks), vb = mkBody(vsock);
    const kst = mkStat('s:' + ks.id), vst = mkStat('s:' + vsock.id);
    rankHooks.lifeStart(kb, kst);
    rankHooks.lifeStart(vb, vst);
    vst.lifeStartAt = Date.now() - 60000;              // victim has been alive a minute
    const bot = mkBody(null, { royaleBornAt: Date.now() - 60000 });
    const youngBot = mkBody(null, { royaleBornAt: Date.now() - 2000 });
    // the killer banks 300 and kills: a bot, a spawn-fresh bot, the victim account three times
    kst.banked = 300;
    const kill = (victim, vs, pts) => { kst.killPts += 200; kst.extra += pts - 200; rankHooks.onKillCredited(kb, kst, victim, vs, pts); };
    kill(bot, null, 200);
    assert.equal(kst.rankDiscount, 100);
    kill(youngBot, null, 200);
    assert.equal(kst.rankDiscount, 300);
    kill(vb, vst, 250);
    kill(vb, vst, 200);
    kill(vb, vst, 200);                                 // the third: nothing
    assert.equal(kst.rankDiscount, 500);
    await sleep(300);
    bridge.tickDU();
    const kdu = packets(ks, 'DU').filter(p => p[4] === 3);
    assert.equal(kdu.reduce((a, p) => a + p[3], 0), 125 + 250 + 250, 'kill dust: bot 125 + two player kills');
    assert.equal(dustHooks.balanceOf(killerU.id), 625);
    // basis: banked 300 + kill points 1050 - discount 500 = 850
    assert.equal(rankHooks.basisOf(kst) - kst.lifeBase, 850);
    rankHooks.onDeath(kb, kst);
    const rk = ks._rkPending;
    assert.equal(rk.basis, 850);
    assert.equal(rk.gain, ranked.lifeGain(0, 850));
    assert.equal(rk.dust.lifeMilli, 625);
    assert.equal(rk.dust.balanceMilli, 625);
    assert.equal(userRow(killerU.id).dust_milli, 625, 'flushed on death');
    assert.equal(D().get('SELECT bot_kills, kills FROM rank_lives WHERE life_id = ?', kst.lifeId).bot_kills, 2);
    bridge.afterDeathPacket(ks);
    assert.equal(json(packets(ks, 'RK')[0]).basis, 850);
    // a second death call (the mass death, a double camera tick) settles nothing
    rankHooks.onDeath(kb, kst);
    assert.equal(ks._rkPending, null);
    assert.equal(D().get('SELECT count(*) AS n FROM rank_lives WHERE user_id = ?', killerU.id).n, 1);
    // the raid-cumulative counted points feed the next life's curve
    assert.equal(rankHooks._raidAcct.get(killerU.id).counted, 850);
    H.clients.length = 0; H.stats.clear();
});

test('hooks: a spawn-killed victim pays no fare; guests get the guest RK', () => {
    const vU = mkUser('hk');
    rankStore.debugSetRp(vU.id, 5000);
    const killer = mkBody(mkSocket(null));
    const kst = mkStat('s:' + killer.socket.id);
    rankHooks.lifeStart(killer, kst);
    const vsock = mkSocket(vU), vb = mkBody(vsock);
    const vst = mkStat('s:' + vsock.id);
    rankHooks.lifeStart(vb, vst);
    vst.lifeStartAt = Date.now() - 40000;              // old enough for a fare
    kst.killPts += 200;
    rankHooks.onKillCredited(killer, kst, vb, vst, 200);
    assert.equal(vst.lifeNoFare, false);
    vst.lifeStartAt = Date.now() - 5000;               // spawn-killed this time...
    kst.killPts += 200;
    rankHooks.onKillCredited(killer, kst, vb, vst, 200);
    assert.equal(vst.lifeNoFare, true);
    vst.lifeStartAt = Date.now() - 40000;              // ...so even a long life pays nothing
    rankHooks.onDeath(vb, vst);
    assert.equal(vsock._rkPending.fare, 0);
    assert.equal(D().get('SELECT fare FROM rank_lives WHERE life_id = ?', vst.lifeId).fare, 0);
    // the guest killer: guest RK with wouldBe from Bronze I
    kst.banked = 2000;
    rankHooks.onDeath(killer, kst);
    const g = killer.socket._rkPending;
    assert.deepEqual(Object.keys(g).sort(), ['basis', 'guest', 'v', 'wouldBe'].sort());
    assert.equal(g.guest, true);
    assert.equal(g.basis, 2000 + 200);                 // the first (paid) player kill counts for a guest
    const gain = ranked.lifeGain(0, g.basis);
    assert.deepEqual(g.wouldBe, { division: R.divisionOf(gain), name: R.nameOf(R.divisionOf(gain)) });
    H.clients.length = 0; H.stats.clear();
});

test('hooks: raid end settles every open life (carried half counts), then RKP; the mass death settles nothing', () => {
    const a = mkUser('hk'), b = mkUser('hk');
    rankStore.debugSetRp(a.id, 1000);
    const sa = mkSocket(a), sb = mkSocket(b);
    H.clients.push(sa, sb);
    const ba = mkBody(sa), bb = mkBody(sb);
    const sta = mkStat('s:' + sa.id), stb = mkStat('s:' + sb.id);
    rankHooks.onRaidStart();
    rankHooks.lifeStart(ba, sta);
    rankHooks.lifeStart(bb, stb);
    const botStat = mkStat('b:77');
    botStat.banked = 5000;                              // a bot takes 1st; it is never paid
    sta.banked = 800; sta.carried = 400;                 // 2nd
    stb.banked = 100;                                   // 3rd
    rankHooks.onRaidEnd();
    const rka = sa._rkPending, rkb = sb._rkPending;
    assert.equal(rka.reason, 'raidend');
    assert.equal(rka.basis, 800 + 200);
    assert.equal(rka.fare, 0);
    assert.equal(rkb.basis, 100);
    const rkp = json(packets(sa, 'RKP')[0]);
    assert.deepEqual(Object.keys(rkp).sort(), ['after', 'before', 'bonusDustMilli', 'bonusRP', 'of', 'place', 'raidKey', 'rankUp', 'score', 'tierUp'].sort());
    assert.equal(rkp.place, 2);
    assert.equal(rkp.of, 3);
    assert.equal(rkp.bonusRP, 0, 'under five minutes in the raid');
    assert.equal(rkp.raidKey, rankHooks.BOOT_ID + ':' + H.raidId);
    assert.equal(rkp.before.rp, rka.after.rp, 'RKP starts where the life ended');
    const n = D().get('SELECT count(*) AS n FROM rank_lives WHERE user_id = ?', a.id).n;
    // the mass death a moment later
    rankHooks.onDeath(ba, sta);
    assert.equal(sa._rkPending, rka, 'the stored raid-end RK is what follows F');
    assert.equal(D().get('SELECT count(*) AS n FROM rank_lives WHERE user_id = ?', a.id).n, n);
    assert.equal(D().get('SELECT end_reason FROM rank_lives WHERE life_id = ?', sta.lifeId).end_reason, 'raid_end');
    assert.equal(D().get('SELECT count(*) AS n FROM raid_results WHERE user_id = ?', a.id).n, 1);
    // an eligible placement pays (raid time is from the account's first life)
    H.raidId = 2;
    rankHooks.onRaidStart();
    rankHooks.lifeStart(ba, sta);
    rankHooks._raidAcct.get(a.id).joinedAt -= 6 * 60000;
    sta.banked += 50;
    H.stats.delete('b:77');
    sa.packets.length = 0;
    rankHooks.onRaidEnd();
    const rkp2 = json(packets(sa, 'RKP')[0]);
    assert.equal(rkp2.place, 1);
    assert.equal(rkp2.bonusRP, 40);
    assert.equal(rkp2.bonusDustMilli, 2000);
    assert.equal(rkp2.after.rp, rkp2.before.rp + 40);
    assert.ok(packets(sa, 'DU').some(p => p[4] === 5 && p[3] === 2000), 'DU kind 5 for the placement dust');
    H.clients.length = 0; H.stats.clear(); H.raidId = 3;
    rankHooks.onRaidStart();
});

test('hooks: a disconnect settles after the resume window unless it was resumed', async () => {
    const u = mkUser('hk'), v = mkUser('hk');
    rankStore.debugSetRp(u.id, 3000);
    const su = mkSocket(u), sv = mkSocket(v);
    const bu = mkBody(su), bv = mkBody(sv);
    const stu = mkStat('s:' + su.id), stv = mkStat('s:' + sv.id);
    H.clients.push(su, sv);
    rankHooks.lifeStart(bu, stu);
    rankHooks.lifeStart(bv, stv);
    stu.lifeStartAt -= 45000;                            // a 45 s life
    // both drop; v comes back (the stat is re-keyed to the new socket)
    H.clients.length = 0;
    rankHooks.onDisconnect(su, stu);
    rankHooks.onDisconnect(sv, stv);
    const sv2 = mkSocket(v);
    H.stats.delete(stv.key); stv.key = 's:' + sv2.id; H.stats.set(stv.key, stv);
    H.clients.push(sv2);
    await sleep(1500);                                   // resumeMs 300 + 1 s
    assert.equal(stu.lifeOpen, false);
    const row = D().get('SELECT end_reason, fare, delta FROM rank_lives WHERE life_id = ?', stu.lifeId);
    assert.deepEqual(row, { end_reason: 'disconnect', fare: 3, delta: -3 });   // Platinum I
    assert.equal(stv.lifeOpen, true, 'the resumed life stays open');
    assert.equal(D().get('SELECT ended_at FROM rank_lives WHERE life_id = ?', stv.lifeId).ended_at, null);
    // a later spawn on the new socket keeps it and cancels any pending settle
    rankHooks.lifeStart(mkBody(sv2), stv);
    assert.equal(stv.lifeOpen, true);
    H.clients.length = 0; H.stats.clear();
});

test('dust hooks: pickup, satchel out, DU coalescing (<= 4/s), soft cap, death split, resume stash', async () => {
    const u = mkUser('du');
    const sock = mkSocket(u);
    const body = mkBody(sock, { carriedGems: 0 });
    // pickups: per gem entity, dropped pieces carry their own share
    for (let i = 0; i < 10; i++) dustHooks.onPickup(body, { gemOre: 1 });
    dustHooks.onPickup(body, { gemOre: 4 });
    dustHooks.onPickup(body, { gemOre: 3, gemDust: 7 });
    dustHooks.onPickup(body, { gemOre: 2, gemDust: 0 });
    assert.equal(body.dustCarried, 10 * 10 + 100 + 7);
    const du1 = packets(sock, 'DU');
    assert.ok(du1.length <= 2, 'coalesced: ' + du1.length + ' DU for 13 pickups');
    await sleep(300);
    bridge.tickDU();
    const pick = packets(sock, 'DU').filter(p => p[4] === 1);
    assert.equal(pick.reduce((a, p) => a + p[3], 0), 207);
    assert.equal(pick[pick.length - 1][1], 207);
    // bank 100 of 300 gems at an outpost (0.8), then the rest at a vault
    body.carriedGems = 300;
    dustHooks.onSatchelOut(body, 100, 300, 0.8);
    assert.equal(body.dustCarried, 207 - 69);
    dustHooks.onSatchelOut(body, 200, 200, 1);
    assert.equal(body.dustCarried, 0);
    dustHooks.onBankDone(body);
    const expect = Math.floor(69 * 0.8) + 138;
    assert.equal(userRow(u.id).dust_milli, expect);
    const last = packets(sock, 'DU').pop();
    assert.deepEqual(last.slice(1, 3), [0, expect]);
    assert.equal(last[4], 2);
    // soft cap: near the cap, a player kill pays 10 + 240 at 25%
    D().run('UPDATE users SET earn_day = ?, earn_day_milli = ? WHERE id = ?', dust.dayOf(Date.now()), 49990, u.id);
    dustHooks.onClose(sock);                             // forget the in-memory state so it reloads
    const got = dustHooks.creditKill(sock, 250);
    assert.equal(got, 10 + 60);
    dustHooks.flushAccount(u.id);
    assert.equal(userRow(u.id).dust_milli, expect + 70);
    assert.equal(userRow(u.id).earn_day_milli, 50240);
    // insurance + death split
    body.dustCarried = 1001;
    assert.equal(dustHooks.onInsured(body), 250);
    const shares = dustHooks.onDeathDrop(body, [15, 30, 110, 0]);
    assert.equal(shares.reduce((a, b) => a + b, 0), 751);
    assert.equal(shares[3], 0);
    assert.equal(body.dustCarried, 0);
    const death = packets(sock, 'DU').pop();
    assert.deepEqual([death[3], death[4]], [-751, 4]);
    // resume: the dust leaves with the gems and comes back
    body.dustCarried = 555;
    const kept = dustHooks.stash(body);
    assert.equal(body.dustCarried, 0);
    dustHooks.restore(body, kept);
    assert.equal(body.dustCarried, 555);
    // ledger rows add up to the balance
    const sum = D().get('SELECT sum(delta_milli) AS s FROM dust_ledger WHERE user_id = ?', u.id).s;
    assert.equal(sum, userRow(u.id).dust_milli);
    dustHooks.onClose(sock);
});

test('hooks: shutdown settles open lives without a fare', () => {
    const u = mkUser('hk');
    rankStore.debugSetRp(u.id, 6000);
    const sock = mkSocket(u), body = mkBody(sock), st = mkStat('s:' + sock.id);
    H.clients.push(sock);
    rankHooks.lifeStart(body, st);
    st.lifeStartAt -= 90000;
    const lifeId = st.lifeId;
    accounts.shutdown();
    accounts.initMain();
    const row = D().get('SELECT end_reason, fare, delta FROM rank_lives WHERE life_id = ?', lifeId);
    assert.deepEqual(row, { end_reason: 'shutdown', fare: 0, delta: 0 });
    H.clients.length = 0; H.stats.clear();
});

test('http: GET /shared/ranks.js is served read-only; other /shared paths 404', async () => {
    const http = require('http');
    const server = http.createServer((req, res) => { if (!accounts.handleHttp(req, res)) { res.writeHead(418); res.end(); } });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const base = 'http://127.0.0.1:' + server.address().port;
    try {
        let r = await fetch(base + '/shared/ranks.js');
        assert.equal(r.status, 200);
        assert.match(r.headers.get('content-type'), /^application\/javascript/);
        assert.equal(r.headers.get('cache-control'), 'no-cache');
        const text = await r.text();
        assert.equal(text, fs.readFileSync(path.join(REPO, 'shared', 'ranks.js'), 'utf8'));
        const etag = r.headers.get('etag');
        r = await fetch(base + '/shared/ranks.js', { headers: { 'If-None-Match': etag } });
        assert.equal(r.status, 304);
        // raw paths: fetch would normalise the dot segments away
        const raw = p => new Promise((res, rej) => http.get({ host: '127.0.0.1', port: server.address().port, path: p }, x => { x.resume(); res(x.statusCode); }).on('error', rej));
        for (const p of ['/shared/../server/.env', '/shared/%2e%2e/package.json', '/shared/..%2fpackage.json', '/shared/nope.js', '/shared/', '/shared/ranks.js/x', '/shared//ranks.js']) {
            assert.equal(await raw(p), 404, p);
        }
        assert.equal(await raw('/shared/ranks.js?v=2'), 200);
        r = await fetch(base + '/shared/ranks.js', { method: 'POST' });
        assert.equal(r.status, 405);
        r = await fetch(base + '/shared/cosmetics.js');
        assert.equal(r.status, fs.existsSync(path.join(REPO, 'shared', 'cosmetics.js')) ? 200 : 404);
    } finally { server.close(); }
});

// ===================================================================
// End to end: a real server over the game socket
// ===================================================================

async function freePort() {
    for (let i = 0; i < 40; i++) {
        const p = 3800 + Math.floor(Math.random() * 1000);
        const ok = await Promise.all([p, p + 2].map(q => new Promise(res => {
            const s = net.createServer().once('error', () => res(false)).once('listening', () => s.close(() => res(true)));
            s.listen(q, '127.0.0.1');
        })));
        if (ok.every(Boolean)) return p;
    }
    throw new Error('no free port');
}

class Client {
    constructor(port, { cookie, token, name = 'Tester', origin } = {}) {
        const WebSocket = require(path.join(REPO, 'node_modules', 'ws'));
        this.ft = require('../../server/lib/fasttalk.js');
        const headers = { Origin: origin || 'http://localhost:' + port };
        if (cookie) headers.Cookie = cookie;
        this.log = [];
        this.closed = false;
        this.ws = new WebSocket('ws://localhost:' + port, { headers });
        this.ws.binaryType = 'arraybuffer';
        this.token = token || ('tok' + Math.random().toString(36).slice(2, 14));
        this.name = name;
        this.spawnedOnce = false;
        this.ws.on('message', d => {
            const m = this.ft.decode(d);
            if (!m) return;
            const type = m.shift();
            this.log.push({ type, m, at: Date.now() });
            if (type === 'W') this.talk('k', '');
            if (type === 'w') { this.talk('RZ', this.token); this.talk('s', '', 1, 0, false, 0); }
            if (type === 'TG' && !this.spawnedOnce) { this.spawnedOnce = true; setTimeout(() => this.talk('s', this.name, 0, 0, false, 0), 200); }
        });
        this.ws.on('close', () => { this.closed = true; });
        this.ws.on('error', err => { this.error = err; this.log.push({ type: '!error', m: [String(err && err.message)], at: Date.now() }); });
    }
    talk(...m) { try { this.ws.send(this.ft.encode(m)); } catch (e) { /* closed */ } }
    mark() { return this.log.length; }
    since(i, type) { return this.log.slice(i).filter(e => !type || e.type === type); }
    async waitFor(type, pred = () => true, from = 0, ms = 20000) {
        const end = Date.now() + ms;
        while (Date.now() < end) {
            const hit = this.log.slice(from).find(e => e.type === type && pred(e.m));
            if (hit) return hit;
            await sleep(50);
        }
        const msgs = this.log.slice(from).filter(e => e.type === 'm').map(e => e.m[e.m.length - 1]).slice(-4);
        throw new Error(`timed out waiting for ${type}; saw ${[...new Set(this.log.slice(from).map(e => e.type))].join(',')}` +
            (msgs.length ? '; messages: ' + JSON.stringify(msgs) : '') + (this.error ? ' (socket error: ' + this.error.message + ')' : ''));
    }
    respawn() { this.talk('s', this.name, 0, 0, false, 0); }
    // the spawn shield only drops on a fresh input after its 4 s grace
    async unshield() { this.talk('C', 100, 0, 0, 1); await sleep(400); this.talk('C', 100, 0, 0, 0); await sleep(200); }
    // DBG kill, retried if a slow tick swallowed the input that drops the
    // shield. -> the log index the death started from
    async die() {
        for (let attempt = 0; attempt < 4; attempt++) {
            await this.unshield();
            const i0 = this.mark();
            this.talk('DBG', 'kill');
            for (let j = 0; j < 40; j++) {
                if (this.log.slice(i0).some(e => e.type === 'F')) return i0;
                await sleep(75);
            }
        }
        throw new Error('DBG kill never produced F');
    }
    close() { try { this.ws.close(); } catch (e) { /* */ } }
}
const du = e => ({ carried: e.m[0], balance: e.m[1], delta: e.m[2], kind: e.m[3] });

test('e2e: account socket, dust, death RK, resume, fare, disconnect, raid end (local server)', async () => {
    if (process.env.RANKED_E2E === '0') return 'skipped (RANKED_E2E=0)';
    const port = await freePort();
    const origin = 'http://localhost:' + port;
    fs.mkdirSync(E2E_DATA_DIR, { recursive: true });
    const env = { ...process.env, ROYALE_DEBUG: '1', ACCOUNTS_ALLOW_DEBUG: '1', ROYALE_RESUME_MS: '5000',
        SESSION_SECRET: SECRET, DATA_DIR: E2E_DATA_DIR, PUBLIC_ORIGIN: origin, PUBLIC_HOST: 'localhost:' + port,
        TRUSTED_PROXIES: '127.0.0.1', SINGLE_PROCESS: 'true', PORT: String(port), BR_PORT: String(port), TUT_PORT: String(port + 2) };
    delete env.NODE_ENV;
    const logFile = path.join(ROOT, 'e2e-server.log');
    const out = fs.openSync(logFile, 'w');
    const child = spawn(process.execPath, ['index.js'], { cwd: REPO, env, stdio: ['ignore', out, out] });
    const clients = [];
    const { DatabaseSync } = require('node:sqlite');
    let db = null;
    try {
        for (let i = 0; i < 120; i++) {
            try { if ((await fetch(origin + '/api/config')).status === 200) break; } catch (e) { /* booting */ }
            await sleep(250);
        }
        // HTTP answers before the game socket is wired: wait for a real welcome
        let ready = false;
        for (let i = 0; i < 20 && !ready; i++) {
            const c = new Client(port, { name: 'Probe' });
            for (let j = 0; j < 20 && !c.log.some(x => x.type === 'W'); j++) await sleep(100);
            ready = c.log.some(x => x.type === 'W');
            c.spawnedOnce = true;
            c.close();
            if (!ready) await sleep(500);
        }
        assert.ok(ready, 'game socket never welcomed a client');
        await sleep(300);
        const r = await fetch(origin + '/api/auth/signup', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'E2e_Ranked' + Math.floor(Math.random() * 1000), password: 'correct-horse-9' }) });
        assert.equal(r.status, 201);
        const cookie = r.headers.get('set-cookie').split(';')[0];
        db = new DatabaseSync(path.join(E2E_DATA_DIR, 'digwars.db'));
        const q = (sql, ...a) => db.prepare(sql).get(...a);
        const qa = (sql, ...a) => db.prepare(sql).all(...a);
        const uid = q('SELECT id FROM users ORDER BY id DESC LIMIT 1').id;
        const me = await (await fetch(origin + '/api/me', { headers: { Cookie: cookie } })).json();
        assert.equal(me.user.rank.placement.done, false);
        assert.equal(me.user.dust, 0);

        // ---- connect: AC + DU sync ----
        const t0 = Date.now();
        const A = new Client(port, { cookie, token: 'tokRankedA1' });
        clients.push(A);
        const ac = await A.waitFor('AC');
        const acj = JSON.parse(ac.m[0]);
        assert.equal(acj.userId, me.user.userId);
        assert.equal(acj.rank.division, null);
        assert.equal(acj.dust, 0);
        await A.waitFor('DU', m => m[3] === 0);
        await sleep(4500);                               // spawn grace

        // ---- pickups mint dust; DBG carry does not ----
        A.talk('DBG', 'god');
        let i0 = A.mark();
        A.talk('DBG', 'gem', 4, 1);
        let e = await A.waitFor('DU', m => m[3] === 1, i0);
        assert.deepEqual([du(e).carried, du(e).delta], [100, 100]);
        i0 = A.mark();
        A.talk('DBG', 'carry', 400);
        await sleep(800);
        assert.equal(A.since(i0, 'DU').length, 0, 'DBG carry sends no dust');
        // bank everything at a vault: exactly the emerald's 100 comes out
        // (a pad another miner holds refuses the deposit: try the next vault)
        i0 = A.mark();
        let banked = false;
        for (let v = 0; v < 4 && !banked; v++) {
            A.talk('DBG', 'vault', v);
            await sleep(600);
            A.talk('vd', 100000);
            for (let j = 0; j < 80 && !banked; j++) {
                banked = A.since(i0, 'DU').some(x => x.m[3] === 2 && x.m[0] === 0);
                if (!banked) await sleep(100);
            }
        }
        assert.ok(banked, 'banked at a vault');
        await sleep(400);
        const bankDus = A.since(i0, 'DU').map(du);
        assert.equal(bankDus.filter(d => d.kind === 2).reduce((a, d) => a + d.delta, 0), 100);
        assert.equal(bankDus[bankDus.length - 1].balance, 100);
        assert.equal(q('SELECT dust_milli FROM users WHERE id = ?', uid).dust_milli, 100);
        assert.deepEqual(qa('SELECT DISTINCT kind FROM dust_ledger WHERE user_id = ?', uid).map(x => x.kind), ['gems']);
        assert.equal(q('SELECT sum(delta_milli) AS s FROM dust_ledger WHERE user_id = ?', uid).s, 100);

        // ---- a bot kill pays 125 (a bot older than 15 s, off the pads) ----
        let killed = false;
        for (let tries = 0; tries < 30 && !killed; tries++) {
            i0 = A.mark();
            A.talk('DBG', 'killbot', 16000);
            const reply = JSON.parse((await A.waitFor('KC', m => m[0] === 'dbg', i0, 5000)).m[1]);
            killed = reply.killbot === 1;
            if (!killed) await sleep(reply.ageMs >= 0 ? Math.min(4000, Math.max(300, 16000 - reply.ageMs)) : 1000);
        }
        assert.ok(killed, 'found a bot to kill');
        e = await A.waitFor('DU', m => m[3] === 3, i0, 8000);
        assert.deepEqual([du(e).delta, du(e).balance], [125, 225]);

        // ---- death: F, then RK (placement life 1) ----
        A.talk('DBG', 'god');
        await sleep(200);
        i0 = await A.die();
        const f1 = await A.waitFor('F', () => true, i0, 8000);
        const rk1e = await A.waitFor('RK', () => true, i0, 3000);
        assert.ok(A.log.indexOf(rk1e) > A.log.indexOf(f1), 'RK after F');
        const rk1 = JSON.parse(rk1e.m[0]);
        assert.equal(rk1.reason, 'death');
        assert.equal(rk1.guest, false);
        assert.ok(rk1.basis > 0);
        assert.equal(rk1.gain, ranked.lifeGain(0, rk1.basis));
        assert.equal(rk1.fare, 0);
        assert.equal(rk1.delta, rk1.gain);
        assert.deepEqual(rk1.placement, { inPlacement: true, lives: 1, of: 3, finished: false, startDivision: null });
        assert.deepEqual(rk1.dust, { lifeMilli: 225, balanceMilli: 225 });
        const row1 = q("SELECT * FROM rank_lives WHERE user_id = ? AND end_reason = 'death'", uid);
        assert.equal(row1.delta, rk1.delta);
        assert.equal(row1.bot_kills, 1);
        assert.equal(q('SELECT placement_lives FROM users WHERE id = ?', uid).placement_lives, 1);
        assert.ok(A.since(i0, 'DU').some(x => x.m[3] === 4), 'DU on death');

        // ---- respawn, go Platinum I, resume keeps the life ----
        i0 = A.mark();
        A.respawn();
        await A.waitFor('AC', () => true, i0, 25000);
        const spawnAt = Date.now();
        await sleep(500);
        const openRow = q('SELECT life_id FROM rank_lives WHERE user_id = ? AND ended_at IS NULL', uid);
        assert.ok(openRow, 'a life opened at the respawn');
        i0 = A.mark();
        A.talk('DBG', 'rank', 2700);
        const acPlat = JSON.parse((await A.waitFor('AC', () => true, i0)).m[0]);
        assert.equal(acPlat.rank.division, 9);
        assert.equal(acPlat.rank.name, 'Platinum I');
        A.close();
        await sleep(700);
        const A2 = new Client(port, { cookie, token: 'tokRankedA1' });
        clients.push(A2);
        await A2.waitFor('AC');
        await sleep(800);
        const open2 = qa('SELECT life_id FROM rank_lives WHERE user_id = ? AND ended_at IS NULL', uid);
        assert.deepEqual(open2.map(x => x.life_id), [openRow.life_id], 'resumed: the same single open life');

        // ---- a 30 s+ Platinum life with no points pays the fare ----
        await sleep(Math.max(4500, 31000 - (Date.now() - spawnAt)));
        i0 = await A2.die();
        await A2.waitFor('F', () => true, i0, 8000);
        const rk2 = JSON.parse((await A2.waitFor('RK', () => true, i0, 3000)).m[0]);
        assert.equal(rk2.before.division, 9);
        assert.equal(rk2.fare, 3);
        assert.equal(rk2.delta, rk2.gain - 3);
        assert.equal(rk2.after.rp, 2700 + rk2.delta);
        assert.equal(rk2.rankDown, false);
        assert.equal(q('SELECT rp FROM users WHERE id = ?', uid).rp, rk2.after.rp);

        // ---- disconnect without a resume: settles after the window ----
        i0 = A2.mark();
        A2.respawn();
        await A2.waitFor('AC', () => true, i0, 25000);
        await sleep(600);
        const open3 = q('SELECT life_id FROM rank_lives WHERE user_id = ? AND ended_at IS NULL', uid);
        assert.ok(open3);
        A2.close();
        await sleep(5000 + 1000 + 1500);
        const row3 = q('SELECT end_reason, ended_at FROM rank_lives WHERE life_id = ?', open3.life_id);
        assert.equal(row3.end_reason, 'disconnect');

        // ---- a guest gets the guest RK ----
        const G = new Client(port, { name: 'GuestTester' });
        clients.push(G);
        await G.waitFor('c', () => true, 0, 15000);       // spawned (camera)
        await sleep(5000);
        i0 = await G.die();
        await G.waitFor('F', () => true, i0, 8000);
        const grk = JSON.parse((await G.waitFor('RK', () => true, i0, 3000)).m[0]);
        assert.deepEqual(Object.keys(grk).sort(), ['basis', 'guest', 'v', 'wouldBe'].sort());
        assert.equal(grk.guest, true);
        assert.equal(G.log.filter(x => x.type === 'AC' || x.type === 'DU').length, 0, 'no AC / DU for guests');

        // ---- raid end: RKP, then F + RK once; the mass death settles nothing more ----
        const A3 = new Client(port, { cookie, token: 'tokRankedA3' });
        clients.push(A3);
        await A3.waitFor('AC');
        // past the spawn grace: a tank spawned a moment before the raid ends
        // can outlive the mass death (a game quirk, also on HEAD before Phase 2)
        await sleep(5000);
        const open4 = q('SELECT life_id FROM rank_lives WHERE user_id = ? AND ended_at IS NULL', uid);
        assert.ok(open4);
        A3.talk('DBG', 'carry', 300);
        await sleep(500);
        i0 = A3.mark();
        A3.talk('DBG', 'raidend');
        const rkp = JSON.parse((await A3.waitFor('RKP', () => true, i0, 5000)).m[0]);
        assert.ok(rkp.place >= 1 && rkp.place <= 10);
        assert.ok(rkp.raidKey.endsWith(':1'));
        assert.equal(rkp.bonusRP, 0, 'under five minutes');
        const fEnd = await A3.waitFor('F', () => true, i0, 8000);
        const rkEnd = await A3.waitFor('RK', () => true, i0, 3000);
        assert.ok(A3.log.indexOf(rkEnd) > A3.log.indexOf(fEnd));
        const rk4 = JSON.parse(rkEnd.m[0]);
        assert.equal(rk4.reason, 'raidend');
        assert.ok(rk4.basis >= Math.floor(375 / 2), 'carried half counts: ' + rk4.basis);
        assert.equal(rk4.fare, 0);
        const counted = q('SELECT sum(basis) AS s FROM rank_lives WHERE user_id = ? AND life_id <> ?', uid, open4.life_id).s;
        assert.equal(rk4.gain, ranked.lifeGain(counted, rk4.basis), 'curve continues from the raid so far');
        await sleep(2500);
        assert.equal(A3.since(i0, 'RK').length, 1, 'one RK');
        const row4 = qa('SELECT end_reason FROM rank_lives WHERE life_id = ?', open4.life_id);
        assert.deepEqual(row4.map(x => x.end_reason), ['raid_end']);
        assert.equal(q('SELECT count(*) AS n FROM rank_lives WHERE user_id = ? AND ended_at IS NULL', uid).n, 0);
        assert.equal(q('SELECT count(*) AS n FROM raid_results WHERE user_id = ?', uid).n, 1);
        const final = await (await fetch(origin + '/api/me', { headers: { Cookie: cookie } })).json();
        assert.equal(final.user.rank.rp, q('SELECT rp FROM users WHERE id = ?', uid).rp);
        assert.equal(final.user.dust, 0.225);
        return `${((Date.now() - t0) / 1000).toFixed(0)} s of play, lives ${q('SELECT count(*) AS n FROM rank_lives WHERE user_id = ?', uid).n}`;
    } finally {
        for (const c of clients) c.close();
        if (db) try { db.close(); } catch (e) { /* */ }
        child.kill('SIGINT');
        await new Promise(res => { if (child.exitCode !== null) res(); else child.once('exit', res); setTimeout(res, 5000); });
        fs.closeSync(out);
    }
});

// ===================================================================

async function main() {
    const quietLog = console.log, quietWarn = console.warn;
    console.log = (...args) => { if (!String(args[0]).startsWith('[accounts]')) quietLog(...args); };
    console.warn = (...args) => { if (!String(args[0]).startsWith('[accounts]')) quietWarn(...args); };
    assert.equal(accounts.initMain(), true, 'initMain');
    let failed = 0;
    const t0 = Date.now();
    const only = process.env.RANKED_ONLY;
    for (const t of tests) {
        if (only && !t.name.startsWith(only)) continue;
        const started = Date.now();
        try {
            const note = await t.fn();
            quietLog(`ok   ${t.name} (${Date.now() - started} ms)${typeof note === 'string' ? ' - ' + note : ''}`);
        } catch (e) {
            failed++;
            quietLog(`FAIL ${t.name}\n     ${((e && e.stack) || e).toString().split('\n').slice(0, 8).join('\n     ')}`);
        }
    }
    accounts.shutdown();
    quietLog(`\n${tests.length - failed}/${tests.length} passed in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    if (!failed) fs.rmSync(ROOT, { recursive: true, force: true });
    else quietLog('test data kept in ' + ROOT);
    process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
