'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Module = require('module');

const REPO = path.join(__dirname, '..', '..');
const SRV = path.join(REPO, 'server', 'game');
process.env.ROYALE_ALWAYS_ON = '1';
delete process.env.ROYALE_DEBUG;
global.Config = { dig_royale: true };
global.gameManager = { port: 4998, terrainGrid: { circleRadius: 4192, rocks: new Map(), vaultSites: [{ x: 0, y: 0, r: 95 }, { x: 2000, y: 0, r: 95 }, { x: -2000, y: 0, r: 95 }], outpostSites: [], shopSites: [] } };

const FX = [];
const stubPath = path.join(SRV, 'gamemodes', 'scripts', 'dig_royale.js');
const stub = new Module(stubPath);
stub.filename = stubPath;
stub.loaded = true;
stub.exports = { fxAt: (x, y, kind, ...extra) => FX.push({ x, y, kind, extra }), fightersNow: () => [], onBossSpawned() { }, onBossDead() { } };
require.cache[stubPath] = stub;
for (const name of ['vault', 'shop']) {
    const p = path.join(SRV, 'terrain', name + '.js');
    const m = new Module(p);
    m.filename = p; m.loaded = true;
    m.exports = { getVaults: () => global.gameManager.terrainGrid.vaultSites, getShops: () => [] };
    require.cache[p] = m;
}

const ao = require(path.join(SRV, 'terrain', 'alwaysOn.js'));
const crowns = require(path.join(SRV, 'terrain', 'crowns.js'));
const bosses = require(path.join(SRV, 'terrain', 'bosses.js'));
const cf = require(path.join(SRV, 'terrain', 'coreFinale.js'));
const ES = require(path.join(SRV, 'terrain', 'eventSpot.js'));
const roster = require(path.join(SRV, 'terrain', 'botRoster.js'));
const rd = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
function lcg(seed) {
    let x = seed >>> 0;
    return () => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return x / 4294967296; };
}

function world() {
    const W = { toasts: [], feed: [], added: [], calls: [], bodies: [], present: new Set(), live: new Map() };
    W.mk = (pid, x, y, bot) => {
        const b = { id: 1000 + W.bodies.length, pid, name: (bot ? 'Bot' : 'P') + pid, x, y, team: 100 + pid, isPlayer: !bot, isBot: !!bot, socket: bot ? undefined : { id: pid },
            health: { max: 200, amount: 200 }, shield: null, velocity: { x: 0, y: 0 }, isDead: () => b.health.amount <= 0, carriedGems: 0 };
        W.bodies.push(b);
        W.present.add(W.key(b));
        W.live.set(W.key(b), b);
        return b;
    };
    W.key = (b) => (b.isBot ? 'b:' : 's:') + b.pid;
    W.kill = (b) => { b.health.amount = 0; if (W.live.get(W.key(b)) === b) W.live.delete(W.key(b)); };
    W.respawn = (b) => { const n = W.mk(b.pid, b.x + 40, b.y, b.isBot); n.name = b.name; return n; };
    W.leave = (b) => { W.kill(b); W.present.delete(W.key(b)); };
    ao.attach({
        fighters: () => W.bodies.filter(b => !b.isDead()),
        keyOf: (b) => W.key(b),
        bodyOfKey: (k) => W.live.get(k) || null,
        keyPresent: (k) => W.present.has(k),
        toast: (t) => W.toasts.push(t),
        feed: (e) => W.feed.push(e),
        fxAt: () => { },
        announceAll: (kind, text, sub) => W.toasts.push(text + ' ' + sub),
        addEvPts: (key, n, why) => W.added.push({ key, n, why }),
        onEventEnd: () => { },
        loadRows: () => { }, saveRows: () => [], humanRows: () => [], dailyReset: () => { },
    });
    crowns.attach({
        keyOf: (b) => W.key(b),
        keyPresent: (k) => W.present.has(k),
        scoreOf: () => 0,
        fighters: () => W.bodies.filter(b => !b.isDead()),
        callout: (b, kind, text, pts, sub) => W.calls.push({ b, kind, text, sub }),
        feed: (e) => W.feed.push(e),
        fxAt: () => { },
        award: () => { },
    });
    return W;
}
function fresh() {
    ao._reset();
    crowns.setAlwaysOn(true);
    crowns.newRaid();
    crowns.clearAll();
    try { bosses.burrow(); } catch (e) { }
    try { cf.clear(); } catch (e) { }
    FX.length = 0;
}

test('spot picker: never within 900 of a tank, close to the wanted spot, off the pads', () => {
    const rng = lcg(5);
    for (let i = 0; i < 300; i++) {
        const x0 = (rng() - 0.5) * 5000, y0 = (rng() - 0.5) * 5000;
        const fighters = [];
        for (let k = 0; k < 6; k++) fighters.push({ x: x0 + (rng() - 0.5) * 700, y: y0 + (rng() - 0.5) * 700, isPlayer: true, socket: {}, isDead: () => false });
        for (let k = 0; k < 6; k++) fighters.push({ x: (rng() - 0.5) * 7000, y: (rng() - 0.5) * 7000, isBot: true, isDead: () => false });
        const p = ES.pick(x0, y0, { size: 110, fighters });
        const human = Math.min(...fighters.filter(f => f.isPlayer).map(f => Math.hypot(f.x - p.x, f.y - p.y)));
        assert.ok(human >= 900, 'a human ' + Math.round(human) + ' away at try ' + i);
        assert.ok(Math.hypot(p.x, p.y) <= 4192 - 110, 'on the map');
        for (const v of global.gameManager.terrainGrid.vaultSites) assert.ok(Math.hypot(v.x - p.x, v.y - p.y) >= 420, 'off the vault pad');
        assert.ok(Math.hypot(p.x - x0, p.y - y0) < 2600, 'near where it was wanted');
    }
    const lone = ES.pick(1200, 300, { size: 80, fighters: [] });
    assert.deepEqual([lone.x, lone.y], [1200, 300], 'an empty spot stays put');
});

test('boss hunt: the boss rises at least 900 from everyone standing on the marker, after a warning', () => {
    for (let round = 0; round < 6; round++) {
        fresh();
        const W = world();
        const t = Date.parse('2026-10-12T12:00:00Z') + round * 1000;
        const n = ao.debugPlan('boss', 30, t);
        const crowd = [W.mk(1, n.x, n.y), W.mk(2, n.x + 120, n.y - 80), W.mk(3, n.x - 200, n.y + 60), W.mk(4, n.x + 40, n.y + 300, true)];
        const r = ao.debugNext(t);
        assert.ok(r.started && r.started.kind === 'boss', 'started');
        const p = bosses.pendingRise();
        assert.ok(p && p.due - t >= 1500, 'a warning comes first, the boss lands ' + (p && p.due - t) + ' ms later');
        assert.ok(FX.some(f => f.kind === 'bossrise'), 'the rise is telegraphed');
        for (const b of crowd) assert.ok(Math.hypot(b.x - p.x, b.y - p.y) >= 900, 'tank ' + b.pid + ' is ' + Math.round(Math.hypot(b.x - p.x, b.y - p.y)) + ' away');
        assert.equal(ao.current().x, p.x, 'the event follows the boss');
        bosses.burrow();
    }
});

test('core siege: the Core rises at least 900 from every tank, then explodes when time runs out', () => {
    fresh();
    const W = world();
    const t = Date.parse('2026-10-12T13:00:00Z');
    const n = ao.debugPlan('core', 30, t);
    const crowd = [W.mk(1, n.x, n.y), W.mk(2, n.x + 300, n.y), W.mk(3, n.x, n.y - 250, true)];
    ao.debugNext(t);
    assert.equal(cf.state(), 'rising', 'it rises after a warning');
    const site = cf.siteOf();
    for (const b of crowd) assert.ok(Math.hypot(b.x - site.x, b.y - site.y) >= 900, 'tank ' + b.pid + ' is ' + Math.round(Math.hypot(b.x - site.x, b.y - site.y)) + ' away');
    assert.ok(rd('server/game/terrain/coreFinale.js').includes("hooks.fxAt(o.x, o.y, 'coreblast'"), 'the timeout blast is an FX');
    ao.finish(t + 5000, true);
    assert.equal(cf.state(), 'idle', 'a rising Core is called off cleanly');
});

test('crowns: a player who died and respawned gets the crown on the new body', () => {
    fresh();
    const W = world();
    const t = Date.parse('2026-10-12T14:00:00Z');
    ao.debugStart('meteor', t);
    const a = W.mk(1, 0, 0), b = W.mk(2, 50, 0), c = W.mk(3, 90, 0, true);
    ao.debugScore(a, 300);
    ao.debugScore(b, 200);
    ao.debugScore(c, 100);
    W.kill(b);
    const b2 = W.respawn(b);
    ao.finish(t + 1000, true);
    assert.ok(b2.crowned, 'the respawned body wears the crown');
    assert.ok(!b.crowned, 'not the dead one');
    assert.ok(a.crowned && c.crowned, 'first and third too');
    assert.ok(W.added.find(x => x.key === 's:2' && /Meteor Shower 2nd/.test(x.why)), 'points labelled');
});

test('crowns: dead at the end, it waits for the next spawn; gone, it is skipped', () => {
    fresh();
    const W = world();
    const t = Date.parse('2026-10-12T15:00:00Z');
    ao.debugStart('meteor', t);
    const a = W.mk(1, 0, 0), b = W.mk(2, 50, 0), c = W.mk(3, 90, 0);
    ao.debugScore(a, 300);
    ao.debugScore(b, 200);
    ao.debugScore(c, 100);
    W.kill(a);
    W.leave(c);
    ao.finish(t + 1000, true);
    assert.ok(b.crowned, 'the live one at once');
    assert.deepEqual(crowns.waitingKeys(), ['s:1'], 'the dead one waits, the one who left does not');
    const a2 = W.respawn(a);
    assert.ok(crowns.onSpawn(a2, t + 4000), 'given on the spawn');
    assert.ok(a2.crowned, 'wears it');
    assert.ok(W.calls.some(x => x.b === a2 && x.kind === 'crowned'), 'and is told');
    assert.equal(crowns.waitingKeys().length, 0);
    const c2 = W.mk(3, 0, 0);
    assert.equal(crowns.onSpawn(c2, t + 5000), false, 'nothing for a player who had left');
});

test('scores: one player with two bodies (a death between hits) gets one combined share', () => {
    fresh();
    const W = world();
    const t = Date.parse('2026-10-12T16:00:00Z');
    ao.debugStart('meteor', t);
    const ev = ao.current();
    const a = W.mk(1, 0, 0), b = W.mk(2, 0, 0);
    W.kill(a);
    const a2 = W.respawn(a);
    ao.shareScores(ev, [{ body: a, share: 0.3, at: 1 }, { body: a2, share: 0.3, at: 2 }, { body: b, share: 0.4, at: 3 }], 1000);
    const e = ev.scores.get('s:1');
    assert.equal(Math.round(e.pts), 600, 'both bodies count');
    assert.equal(e.body, a2, 'the newest body is the one on the row');
});

test('bot goals: most bots head for each event and help, some keep mining', () => {
    const t0 = Date.parse('2026-10-12T17:00:00Z');
    for (const kind of ['storm', 'hill', 'meteor', 'core', 'boss']) {
        fresh();
        const W = world();
        const ev = ao.debugStart(kind, t0);
        assert.ok(ev, kind + ' started');
        const bots = [];
        for (let i = 0; i < 200; i++) bots.push(W.mk(100 + i, ev.x + 2600 * Math.cos(i), ev.y + 2600 * Math.sin(i), true));
        const at = kind === 'storm' ? t0 + 60_000 : t0 + 100;
        const goals = bots.map(b => ao.botGoal(b, at));
        const going = goals.filter(Boolean);
        assert.ok(going.length > 100 && going.length < 190, kind + ': ' + going.length + ' of 200 go');
        for (const g of going) {
            assert.ok(g.kind === 'go' || g.kind === 'shoot' || g.kind === 'boss', kind + ' goal ' + g.kind);
            assert.ok(isFinite(g.x) && isFinite(g.y));
        }
        if (kind === 'hill') {
            for (const g of going) {
                const d = Math.hypot(g.x - ev.x, g.y - ev.y);
                assert.ok(d >= (ev.padR || 130) && d <= ev.r, 'onto the hill ring, not the pad: ' + Math.round(d));
            }
        }
        if (kind === 'core' || kind === 'boss') {
            for (const g of going) assert.ok(Math.hypot(g.x - ev.x, g.y - ev.y) > 600, 'they wait off the spot while it rises');
        }
        assert.deepEqual(goals, bots.map(b => ao.botGoal(b, at + 100)).map((g, i) => goals[i] ? g : null), 'the choice sticks for the event');
        const human = W.mk(999, ev.x, ev.y);
        assert.equal(ao.botGoal(human, t0), null, 'players get no goals');
        bosses.burrow();
        cf.clear();
    }
    fresh();
    const W = world();
    ao.debugStart('core', t0);
    const fakeCore = { id: 77, x: 10, y: 20, realSize: 100, health: { amount: 1, max: 1 }, isDead: () => false };
    const was = cf.current;
    cf.current = () => fakeCore;
    try {
        const bot = W.mk(5, 3000, 0, true);
        let g = null;
        for (let i = 0; i < 40 && !g; i++) { bot._aoBotEv = null; g = ao.botGoal(bot, t0); }
        assert.ok(g && g.kind === 'shoot' && g.target === fakeCore, 'once it is up they shoot the Core');
    } finally { cf.current = was; }
    const ctl = rd('server/miscFiles/controllers.js');
    assert.ok(/aoshoot: 52, aogo: 50/.test(ctl), 'event goals rank over mining and chests');
    assert.ok(/this\.eventGoal\(now, health\)/.test(ctl), 'the brain asks for them');
    assert.ok(ctl.includes("if (fish && g.fight) return null;"), 'small fish and bait stay out of the fights');
});

test('no "someone": event lines, toasts and feed always name the right thing', () => {
    fresh();
    const W = world();
    const t = Date.parse('2026-10-12T18:00:00Z');
    ao.debugStart('meteor', t);
    const a = W.mk(1, 0, 0);
    a.name = '';
    const bot = W.mk(2, 0, 0, true);
    bot.name = '';
    ao.debugScore(a, 300);
    ao.debugScore(bot, 200);
    ao.finish(t + 1000, true);
    const all = W.toasts.concat(W.feed.map(f => JSON.stringify(f)), W.added.map(x => x.why), W.calls.map(x => x.text));
    for (const s of all) assert.ok(!/someone/i.test(s), 'no someone in: ' + s);
    const src = rd('public/client/alwaysOn.js');
    const body = src.slice(src.indexOf('export function feedLine'));
    const KIND_COL = { storm: '#b98bff', core: '#ff7ad9', rush: '#f2b83c', hill: '#4ec4e8', boss: '#ff8a5c', meteor: '#ffb347' };
    const feedLine = new Function('KIND_COL', body.replace('export function feedLine', 'return function feedLine'))(KIND_COL);
    const tag = (n) => n;
    const who = (n, d) => n || d;
    for (const f of W.feed.concat([{ ao: 1, soon: 1, k: 'boss', n: 'Boss Hunt', w: 'the East' }, { ao: 1, go: 1, k: 'core', n: 'Core Siege', w: 'the North' },
        { ao: 1, done: 1, k: 'boss', n: 'Boss Hunt', by: 'kai' }, { ao: 1, done: 1, k: 'hill', n: 'King of the Vault', by: '' }, { ao: 1, coreblast: 1, n: 'Core Siege' }])) {
        if (!f.ao) continue;
        const line = feedLine(f, who, tag);
        assert.ok(line && line.text && !/someone|›/i.test(line.text), 'client line: ' + (line && line.text));
    }
    const app = rd('public/client/app.js');
    const fl = app.slice(app.indexOf('function feedLine(f)'), app.indexOf('const vic = who(f.name, "someone");'));
    assert.ok(fl.includes('if (f.ao) return aoHud.feedLine(f, who, tag);'), 'event entries never reach the kill line');
    assert.ok(fl.includes('if (!f.name) return null;'), 'a nameless entry is skipped');
});

test('bot roster: the same bots all day, a fresh set after the daily reset, back after a scale down', () => {
    const rng = lcg(17);
    const real = Math.random;
    Math.random = rng;
    try {
        roster.resetRaid();
        let t = Date.parse('2026-10-12T08:00:00Z');
        roster.setAlwaysOn(false, t);
        roster.setAlwaysOn(true, t);
        let fam = 1;
        const alive = [];
        const seen = new Set();
        let cap = 10;
        const spawn = (back) => {
            const b = back ? { botFamilyId: back.familyId, name: back.name, botNameKey: back.nameKey, color: { base: 3 } }
                : { botFamilyId: 'ao:bot' + fam, name: 'bot' + fam, botNameKey: 'bot' + fam, color: { base: 3 } };
            if (!back) fam++;
            roster.noteJoin(b, t, back);
            alive.push(b);
            seen.add(b.name);
        };
        const fill = () => {
            roster.trimTo(cap - alive.length);
            if (alive.length >= cap || !roster.mayFill(t)) return;
            const p = roster.next(t);
            if (p.entry) spawn(p.entry);
            else if (p.fresh) spawn(null);
        };
        const die = (b, why) => {
            alive.splice(alive.indexOf(b), 1);
            roster.onBotGone(b, t, why);
        };
        const names = () => alive.map(b => b.name).sort().join(',');
        for (let i = 0; i < 60; i++) { fill(); t += 1000; }
        assert.equal(alive.length, 10, 'the world fills up to ten');
        const first = names();
        const end = t + 20 * 60 * 60 * 1000;
        while (t < end) {
            t += 5000;
            if (rng() < 0.08 && alive.length) die(alive[(rng() * alive.length) | 0], '');
            const leaver = roster.pickLeaver(alive, t);
            assert.equal(leaver, null, 'nobody logs off during the day');
            const hr = (end - t) / 3600000;
            cap = hr > 10 && hr < 10.2 ? 6 : 10;
            while (alive.length > cap) die(alive[alive.length - 1], 'despawn');
            fill();
        }
        for (let i = 0; i < 30; i++) { t += 1000; fill(); }
        assert.equal(names(), first, 'the same ten bots after twenty hours');
        assert.equal(seen.size, 10, 'no new names all day');
        const retiring = roster.retireAll(t);
        assert.ok(retiring > 0, 'the reset retires the roster');
        for (let i = 0; i < 600; i++) {
            t += 1000;
            const leaver = roster.pickLeaver(alive, t);
            if (leaver) { roster.logOff(leaver, t); die(leaver, 'logoff'); }
            fill();
        }
        assert.equal(alive.length, 10, 'ten bots again after the reset');
        const after = alive.map(b => b.name);
        assert.ok(after.every(n => !first.split(',').includes(n)), 'all ten are new: ' + after.join(','));
        assert.ok(roster.takeRetired().length >= 10, 'yesterday\'s rows can be swept');
        const saved = alive.map(b => roster.entryOf(b, t));
        roster.setAlwaysOn(false, t);
        roster.resetRaid();
        roster.setAlwaysOn(true, t);
        assert.equal(roster.seed(saved, t), 10, 'a restart seeds the day\'s ten');
        alive.length = 0;
        for (let i = 0; i < 30; i++) { t += 1000; fill(); }
        assert.equal(names(), after.slice().sort().join(','), 'the same ten come back after a restart');
    } finally { Math.random = real; roster.setAlwaysOn(false); roster.resetRaid(); }
});

test('bot roster: points stay on the board, the AO death no longer drops the row, ten bots a day', () => {
    const dr = rd('server/game/gamemodes/scripts/dig_royale.js');
    assert.ok(!dr.includes('raidStats.get(key) === s && !body.crowned) raidStats.delete(key)'), 'a dead bot keeps its row');
    assert.ok(dr.includes("botRoster.onBotGone(body, now(), body._aoLogoff ? 'logoff' : body.deathCause)"), 'a log off is its own exit');
    assert.ok(/function aoBotCap\(hs\)[\s\S]{0,200}return AO_BOTS;/.test(dr), 'ten bots all day');
    assert.ok(dr.includes("botRoster.retireAll(t)"), 'the daily reset swaps the roster');
    assert.ok(dr.includes('if (AO()) aoRosterTick(t);'), 'the roster swap runs on its own clock');
});

test('wiring: new files have no comments or dashes, eventFx is a hot client file', () => {
    for (const f of ['server/game/terrain/botRoster.js', 'server/accounts/dailyScores.js', 'server/game/terrain/eventSpot.js', 'server/game/terrain/bigHit.js', 'public/client/eventFx.js', 'scripts/test/aoEvents.test.js']) {
        const src = rd(f);
        assert.ok(!/\/\*|(^|[^:'"\\])\/\/(?!\/)/m.test(src.replace(/'[^'\n]*'|"[^"\n]*"|`[^`]*`|\/(?![*/])(?:\\.|[^/\n])+\/[gimsuy]*/g, '""')), f + ' has no comments');
        assert.ok(!/\u2014|\u2013/.test(src), f + ' has no dashes');
    }
    const bc = rd('scripts/build-client.js');
    const hot = bc.slice(bc.indexOf('const HOT'), bc.indexOf(']);', bc.indexOf('const HOT')));
    assert.ok(hot.includes('"client/eventFx.js"') && hot.trim().endsWith('"client/funnel.js",'), 'HOT list, funnel last');
    const si = rd('public/client/socketinit.js');
    assert.ok(si.includes("case 'BH':"), 'big hits reach the client');
});

(async () => {
    let failed = 0;
    for (const t of tests) {
        try { await t.fn(); console.log('ok   ' + t.name); }
        catch (e) { failed++; console.log('FAIL ' + t.name + '\n     ' + String(e && e.stack || e).split('\n').slice(0, 8).join('\n     ')); }
    }
    console.log(failed ? `${failed} of ${tests.length} failed` : `all ${tests.length} passed`);
    process.exit(failed ? 1 : 0);
})();
