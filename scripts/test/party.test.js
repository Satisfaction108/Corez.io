// Duo parties and duo teams:
//   node scripts/test/party.test.js
//
// The party store (server/accounts/party.js) and tickets (partyTicket.js)
// on a fake clock, the duo team rules (server/game/duo/duoTeams.js) as pure
// functions, and a bare-HTTP pass over /api/party (guests by code, an
// account invite over SSE, the error cases) against a throwaway database.
// No game server. Data goes under $DATA_DIR if set, otherwise the OS temp
// dir; it is removed when everything passes.
'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const ROOT = process.env.DATA_DIR
    ? path.join(process.env.DATA_DIR, `party-test-${process.pid}-${Date.now()}`)
    : fs.mkdtempSync(path.join(os.tmpdir(), 'dw-party-test-'));
process.env.DATA_DIR = path.join(ROOT, 'data');
delete process.env.DB_PATH;
delete process.env.PUBLIC_HOST;
delete process.env.PUBLIC_ORIGIN;
delete process.env.ALLOWED_ORIGINS;
delete process.env.PARTY_TICKET_SECRET;
process.env.NODE_ENV = 'test';
process.env.ACCOUNTS_ENABLED = 'true';
process.env.SESSION_SECRET = 'party-test-secret-0123456789-abcdefghijklmnop';

const accounts = require('../../server/accounts');
const party = require('../../server/accounts/party');
const ticket = require('../../server/accounts/partyTicket');
const presence = require('../../server/accounts/presence');
const { DuoTeams, teamStandings } = require('../../server/game/duo/duoTeams');
const users = accounts.users;

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
function code(fn) {
    try { fn(); } catch (e) { return e.status + ':' + e.code; }
    return 'ok';
}

// ---- a fake clock for the store ----
let clock = 1_000_000;
const events = [];
function storeWithClock(opts = {}) {
    party.reset();
    events.length = 0;
    party.setHooks({
        now: () => clock,
        changed: (p, why, extra) => events.push({ why, pid: p.id, extra }),
        inviteGone: (iv, reason) => events.push({ why: 'gone:' + reason, id: iv.id }),
        isOnline: opts.isOnline || (() => true),
    });
}
const acct = (id, name) => ({ mk: 'u:' + id, userId: id, publicId: 'DW-' + id, name, guest: false });

// ---- tickets ----

test('tickets: sign/verify, tamper, expiry, purpose and member checks', () => {
    ticket._setSecret('unit-secret');
    const t0 = 5_000_000;
    const tk = ticket.sign({ pid: 'abcdefgh', mk: 'u:7', mates: ['u:7', 'g:xyz123'], n: 'Sam', fill: true }, t0);
    const v = ticket.verify(tk, t0 + 1000);
    assert.equal(v.pid, 'abcdefgh');
    assert.equal(v.mk, 'u:7');
    assert.deepEqual(v.mates, ['u:7', 'g:xyz123']);
    assert.equal(v.fill, true);
    assert.equal(ticket.verify(tk, t0 + ticket.TTL_MS + 1), null, 'expired');
    const [body, sig] = tk.split('.');
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url')), mk: 'u:8' })).toString('base64url') + '.' + sig;
    assert.equal(ticket.verify(forged, t0), null, 'tampered payload');
    assert.equal(ticket.verify(tk.slice(0, -2) + 'AA', t0), null, 'bad signature');
    ticket._setSecret('other-secret');
    assert.equal(ticket.verify(tk, t0), null, 'another secret');
    ticket._setSecret('unit-secret');
    assert.equal(ticket.verify(ticket.sign({ pid: 'abcdefgh', mk: 'u:7', mates: ['u:9'] }, t0), t0), null, 'member not in mates');
    assert.equal(ticket.verify(ticket.sign({ pid: 'x', mk: 'u:7', mates: ['u:7'] }, t0), t0), null, 'bad pid');
    assert.equal(ticket.verify(ticket.sign({ pid: 'abcdefgh', mk: 'root', mates: ['root'] }, t0), t0), null, 'bad member key');
    assert.equal(ticket.verify('not.a.ticket', t0), null);
    assert.equal(ticket.verify(null, t0), null);
    assert.equal(ticket.deriveFrom('s1'), ticket.deriveFrom('s1'), 'derived secret is stable');
    assert.notEqual(ticket.deriveFrom('s1'), ticket.deriveFrom('s2'));
});

// ---- the party store ----

test('store: create, join by code (any case), full, leave hands leadership on, disband', () => {
    storeWithClock();
    const g1 = party.newGuest('  Gus  ').actor, g2 = party.newGuest('Gia').actor, g3 = party.newGuest('').actor;
    assert.equal(g1.name, 'Gus');
    assert.equal(g3.name, 'Guest');
    const p = party.create(g1);
    assert.match(p.code, /^[A-HJ-NP-Z2-9]{5}$/, 'code alphabet has no I, O, 0, 1');
    assert.equal(party.create(g1), p, 'create again: the same party');
    assert.equal(code(() => party.joinByCode(g2, 'nope')), '400:bad_code');
    assert.equal(code(() => party.joinByCode(g2, 'ZZZZZ')), '404:no_party');
    party.joinByCode(g2, ' ' + p.code.toLowerCase().slice(0, 2) + '-' + p.code.toLowerCase().slice(2) + ' ');
    assert.equal(p.members.length, 2);
    assert.equal(code(() => party.joinByCode(g3, p.code)), '409:party_full');
    const v = party.view(p, g2.mk);
    assert.equal(v.full, true);
    assert.equal(v.leader, false);
    assert.deepEqual(v.members.map(m => [m.name, m.you, m.leader]), [['Gus', false, true], ['Gia', true, false]]);
    party.leave(g1);
    assert.equal(p.leader, g2.mk, 'the one left leads');
    assert.equal(party.view(p, g2.mk).leader, true);
    party.leave(g2);
    assert.equal(party.partyOf(g2.mk), null);
    assert.equal(code(() => party.joinByCode(g3, p.code)), '404:no_party', 'the code dies with the party');
    assert.ok(events.some(e => e.why === 'disband'));
});

test('store: joining someone else leaves your party of one; a party of two must be left first', () => {
    storeWithClock();
    const a = party.newGuest('A').actor, b = party.newGuest('B').actor, c = party.newGuest('C').actor;
    const pa = party.create(a), pb = party.create(b);
    party.joinByCode(a, pb.code);
    assert.equal(party.partyOf(a.mk), pb);
    assert.equal(party.byId(pa.id), null, 'the old party of one is gone');
    const pc = party.create(c);
    assert.equal(code(() => party.joinByCode(a, pc.code)), '409:already_in_party');
});

test('store: blocked accounts cannot team up by code', () => {
    storeWithClock();
    const a = acct(1, 'Ann'), b = acct(2, 'Bob');
    const p = party.create(a);
    assert.equal(code(() => party.joinByCode(b, p.code, { blocked: (x, y) => (x === 2 && y === 1) })), '403:cant_join');
    party.joinByCode(b, p.code, { blocked: () => false });
    assert.equal(p.members.length, 2);
});

test('store: invites - self, dedupe, accept, decline, expiry, full, in another party', () => {
    storeWithClock();
    const a = acct(1, 'Ann'), b = acct(2, 'Bob'), c = acct(3, 'Cy'), d = acct(4, 'Di');
    assert.equal(code(() => party.invite(a, { userId: 1, name: 'Ann' })), '400:self');
    const r1 = party.invite(a, { userId: 2, name: 'Bob' });
    assert.ok(r1.fresh);
    const r2 = party.invite(a, { userId: 2, name: 'Bob' });
    assert.equal(r2.fresh, false, 'a double invite refreshes the same one');
    assert.equal(r2.invite.id, r1.invite.id);
    assert.equal(party.invitesFor(2).length, 1);
    // decline tells the inviter
    party.respond(b, r1.invite.id, false);
    assert.ok(events.some(e => e.why === 'declined' && e.extra.who === 'Bob'));
    assert.equal(party.invitesFor(2).length, 0);
    // expiry
    const r3 = party.invite(a, { userId: 2, name: 'Bob' });
    clock += party.INVITE_MS + 1;
    assert.equal(code(() => party.respond(b, r3.invite.id, true)), '410:invite_gone');
    // accept
    const r4 = party.invite(a, { userId: 2, name: 'Bob' });
    assert.equal(code(() => party.respond(c, r4.invite.id, true)), '404:invite_gone', 'only the invitee answers');
    const res = party.respond(b, r4.invite.id, true);
    assert.equal(res.party.members.length, 2);
    assert.equal(code(() => party.invite(a, { userId: 3, name: 'Cy' })), '409:party_full');
    assert.equal(code(() => party.invite(a, { userId: 2, name: 'Bob' })), '409:already_together');
    // someone in a full party can't be invited
    assert.equal(code(() => party.invite(c, { userId: 2, name: 'Bob' })), '409:in_party');
    // accepting one invite ends your others; an invite into a party that filled
    const rc = party.invite(c, { userId: 4, name: 'Di' });
    const rd = party.invite(acct(5, 'Ed'), { userId: 4, name: 'Di' });
    party.respond(d, rc.invite.id, true);
    assert.equal(code(() => party.respond(d, rd.invite.id, true)), '404:invite_gone', 'joining ended the other invite');
});

test('store: cross-invites collapse into one party, no leftover invite', () => {
    storeWithClock();
    const a = acct(1, 'Ann'), b = acct(2, 'Bob');
    // both ask at once: the second ask is a yes, so Bob joins Ann's party
    const ra = party.invite(a, { userId: 2, name: 'Bob' });
    const rb = party.invite(b, { userId: 1, name: 'Ann' });
    assert.equal(rb.merged, true);
    assert.equal(rb.party.id, ra.party.id);
    assert.deepEqual(rb.party.members.map(m => m.name), ['Ann', 'Bob']);
    assert.equal(party._counts().parties, 1);
    assert.equal(party._counts().invites, 0, 'the ask that was answered is gone');
    assert.equal(code(() => party.respond(b, ra.invite.id, true)), '404:invite_gone', 'a late Join on it: gone (the client sees it is teamed)');
    // tickets for both name the same party
    ticket._setSecret('unit-secret');
    const mates = rb.party.members.map(m => m.mk);
    const ta = ticket.verify(ticket.sign({ pid: rb.party.id, mk: a.mk, mates }));
    const tb = ticket.verify(ticket.sign({ pid: rb.party.id, mk: b.mk, mates }));
    assert.equal(ta.pid, tb.pid);
});

test('tickets: an expired ticket verifies only inside the grace window, marked expired', () => {
    ticket._setSecret('unit-secret');
    const t0 = 7_000_000;
    const tk = ticket.sign({ pid: 'abcdefgh', mk: 'u:7', mates: ['u:7', 'u:8'] }, t0);
    const late = t0 + ticket.TTL_MS + 60_000;
    assert.equal(ticket.verify(tk, late), null);
    const v = ticket.verify(tk, late, { graceMs: 120_000 });
    assert.ok(v && v.expired === true && v.mk === 'u:7');
    assert.equal(ticket.verify(tk, t0 + 1).expired, false);
    assert.equal(ticket.verify(tk, late + 120_000, { graceMs: 120_000 }), null, 'past the grace too');
});

test('store: leaving cancels your invites; the inviter leaving voids the invite', () => {
    storeWithClock();
    const a = acct(1, 'Ann'), b = acct(2, 'Bob');
    const r = party.invite(a, { userId: 2, name: 'Bob' });
    party.leave(a);
    assert.ok(events.some(e => e.why === 'gone:left' && e.id === r.invite.id));
    assert.equal(code(() => party.respond(b, r.invite.id, true)), '404:invite_gone');
});

test('store: launch moves launch.seq for both; views say who pressed Play', () => {
    storeWithClock();
    const a = party.newGuest('A').actor, b = party.newGuest('B').actor;
    const p = party.create(a);
    party.joinByCode(b, p.code);
    party.launch(a);
    party.launch(a);
    assert.equal(party.view(p, b.mk).launch.seq, 2);
    assert.equal(party.view(p, b.mk).launch.by, 'A');
    assert.equal(party.view(p, b.mk).launch.byYou, false);
    assert.equal(party.view(p, a.mk).launch.byYou, true);
    assert.equal(code(() => party.launch(party.newGuest('Z').actor)), '404:no_party');
});

test('store: sweep drops idle guests and offline accounts, never someone in the raid', () => {
    let online = true;
    storeWithClock({ isOnline: () => online });
    const g = party.newGuest('G').actor, h = party.newGuest('H').actor;
    const p = party.create(g);
    party.joinByCode(h, p.code);
    party.onGameMessage({ t: 'duoJoin', mk: h.mk });
    assert.equal(party.view(p, g.mk).members[1].state, 'playing');
    clock += party.GUEST_IDLE_MS + 1;
    party.touch(g.mk);
    party.sweep();
    assert.equal(p.members.length, 2, 'the playing guest stays, the polling one stays');
    party.onGameMessage({ t: 'duoLeave', mk: h.mk });
    clock += party.GUEST_IDLE_MS + 1;
    party.touch(g.mk);
    party.sweep();
    assert.deepEqual(p.members.map(m => m.name), ['G'], 'the silent guest timed out');
    assert.ok(events.some(e => e.why === 'timeout'));
    // accounts: offline for a minute
    const a = acct(1, 'Ann'), b = acct(2, 'Bob');
    const pa = party.create(a);
    party.respond(b, party.invite(a, { userId: 2, name: 'Bob' }).invite.id, true);
    online = false;
    assert.equal(party.view(pa, a.mk).members[1].state, 'menu', 'no stream but seen just now (a polling menu): not away');
    clock += party.AWAY_GRACE_MS + 1;
    assert.equal(party.view(pa, a.mk).members[1].state, 'away');
    clock += party.ACCOUNT_IDLE_MS - 1000 - party.AWAY_GRACE_MS - 1;
    party.sweep();
    assert.equal(pa.members.length, 2, 'not yet');
    clock += 2000;
    party.sweep();
    assert.equal(party.byId(pa.id), null, 'both offline long enough: gone');
});

// ---- duo teams (pure) ----

function book(t0 = 100000) {
    let t = t0, next = -200;
    const b = new DuoTeams({ now: () => t, newTeamId: () => next-- });
    b.tick = ms => { t += ms; };
    return b;
}

test('duo teams: party members share a team that never takes strangers', () => {
    const b = book();
    const r1 = b.join({ mk: 'u:1', pid: 'P1', mates: ['u:1', 'u:2'], fill: true, name: 'Ann' });
    assert.ok(r1.created);
    const lone = b.join({ mk: 't:x', fill: true, name: 'Lone' });
    assert.notEqual(lone.team.id, r1.team.id, 'a filler does not take a reserved party slot');
    const r2 = b.join({ mk: 'u:2', pid: 'P1', mates: ['u:1', 'u:2'], fill: true, name: 'Bob' });
    assert.equal(r2.team.id, r1.team.id);
    assert.equal(r2.paired, true);
    assert.equal(b.mateOf('u:1').mk, 'u:2');
    const again = b.join({ mk: 'u:1', pid: 'P1', fill: true });
    assert.equal(again.team.id, r1.team.id, 'respawn/reconnect: same team');
    assert.equal(again.created, false);
});

test('duo teams: two lone fillers pair; fill off stays alone; a late filler takes the empty slot', () => {
    const b = book();
    const a = b.join({ mk: 't:a', fill: true });
    const off = b.join({ mk: 't:off', fill: false });
    const c = b.join({ mk: 't:c', fill: true });
    assert.equal(c.team.id, a.team.id, 'paired');
    assert.notEqual(off.team.id, a.team.id);
    const d = b.join({ mk: 't:d', fill: true });
    assert.notEqual(d.team.id, off.team.id, 'fill off never gets a stranger');
    assert.equal(d.team.members.size, 1);
    // c drops for good; a fresh filler then joins a (now alone) once the slot frees
    b.away('t:c');
    b.tick(b.awayMs + 1);
    b.sweep();
    assert.equal(b.teamOf('t:c'), null);
    const e = b.join({ mk: 't:e', fill: true });
    assert.equal(e.team.id, a.team.id, 'the oldest open team gets the next filler');
});

test('duo teams: an away member keeps the slot; a party whose mate never came opens after the reservation', () => {
    const b = book();
    const a = b.join({ mk: 't:a', fill: true });
    const c = b.join({ mk: 't:c', fill: true });
    b.away('t:c');
    const x = b.join({ mk: 't:x', fill: true });
    assert.notEqual(x.team.id, a.team.id, 'slot held while away');
    const back = b.join({ mk: 't:c', fill: true });
    assert.equal(back.team.id, a.team.id);
    assert.equal(b.teamOf('t:c').members.get('t:c').away, 0);
    // party with a no-show mate
    const p = b.join({ mk: 'u:9', pid: 'P9', mates: ['u:9', 'u:10'], fill: true });
    const y = b.join({ mk: 't:y', fill: true });
    assert.notEqual(y.team.id, p.team.id);
    b.tick(b.reserveMs + 1);
    const z = b.join({ mk: 't:z', fill: true });
    assert.ok(z.team.id === p.team.id || z.team.id === y.team.id, 'after the reservation the party team can be filled');
    // fill-off party never opens
    const q = b.join({ mk: 'u:20', pid: 'P20', mates: ['u:20', 'u:21'], fill: false });
    b.tick(b.reserveMs + 1);
    assert.equal(b.fillable(q.team), false);
});

test('duo teams: a ticket for a new party moves you over', () => {
    const b = book();
    const a = b.join({ mk: 'u:1', pid: 'OLD', mates: ['u:1', 'u:2'], fill: true });
    const n = b.join({ mk: 'u:1', pid: 'NEW', mates: ['u:1', 'u:3'], fill: true });
    assert.notEqual(n.team.id, a.team.id);
    assert.equal(b.teamById(a.team.id), null, 'the old empty team is gone');
});

test('duo teams: team standings group rows and sum scores', () => {
    const rows = [
        { id: 1, tm: -1, name: 'A', score: 300, kills: 1, gems: 100, alive: true },
        { id: 2, tm: -1, name: 'B', score: 200, kills: 0, gems: 50, alive: false },
        { id: 3, tm: -2, name: 'C', score: 450, kills: 2, gems: 10, alive: true },
        { id: 4, name: 'D', score: 10, kills: 0, gems: 0, alive: false },
    ];
    const t = teamStandings(rows);
    assert.deepEqual(t.map(x => [x.tm, x.score, x.place]), [[-1, 500, 1], [-2, 450, 2], [null, 10, 3]]);
    assert.equal(t[0].alive, true);
    assert.equal(t[0].kills, 1);
    assert.equal(t[0].rows.length, 2);
});

test('duo fill queue: two waiters pair at once, a lone waiter gets a bot after the wait, bot teams take no strangers', () => {
    const b = book();
    b.wait('t:a', 'Ann');
    assert.deepEqual(b.match(), [], 'alone and early: still waiting');
    assert.equal(b.teamOf('t:a'), null);
    b.tick(10000);
    b.wait('t:b', 'Bob');
    const ev = b.match();
    assert.equal(ev.length, 1);
    assert.equal(ev[0].kind, 'pair');
    assert.deepEqual(ev[0].mks.sort(), ['t:a', 't:b']);
    assert.equal(b.teamOf('t:a').id, b.teamOf('t:b').id, 'same team');
    assert.ok(b.teamOf('t:a').key, 'a formed pair has a standings key');
    assert.equal(b.waiting.size, 0);
    // a lone waiter: bot after fillWaitMs
    b.wait('t:c', 'Cy');
    b.tick(b.fillWaitMs - 1);
    assert.deepEqual(b.match(), []);
    b.tick(2);
    const ev2 = b.match();
    assert.equal(ev2.length, 1);
    assert.equal(ev2[0].kind, 'bot');
    const bt = b.teamOf('t:c');
    assert.ok(bt.bot && bt.key && bt.members.size === 1);
    assert.equal(b.fillable(bt), false, 'a bot team never takes a stranger');
    // a later lone filler waits themselves (no swap)
    b.wait('t:d', 'Di');
    assert.deepEqual(b.match(), []);
    assert.notEqual(b.teamOf('t:d'), bt);
    // no room for a bot: held in the queue
    b.tick(b.fillWaitMs + 1);
    assert.deepEqual(b.match(() => false), []);
    assert.ok(b.isWaiting('t:d'));
    b.unwait('t:d');
    assert.equal(b.isWaiting('t:d'), false);
});

test('duo fill queue: a waiter takes the empty slot of a player whose partner left for good; a re-formed pair gets a new key', () => {
    const b = book();
    b.wait('t:a'); b.wait('t:b');
    b.match();
    const team = b.teamOf('t:a');
    const k1 = team.key;
    b.away('t:b');
    b.tick(b.awayMs + 1);
    b.sweep();
    assert.equal(team.members.size, 1);
    b.wait('t:n', 'New');
    const ev = b.match();
    assert.equal(ev[0].kind, 'join');
    assert.equal(b.teamOf('t:n'), team);
    assert.notEqual(team.key, k1, 'new formation, new key: the departed row stays out');
    // party members never enter the queue path: join() as before
    const p = b.join({ mk: 'u:1', pid: 'P', mates: ['u:1', 'u:2'], fill: true });
    assert.equal(b.isWaiting('u:1'), false);
    assert.equal(p.team.key, null, 'a party of one has no key yet');
    b.join({ mk: 'u:2', pid: 'P', mates: ['u:1', 'u:2'], fill: true });
    assert.ok(p.team.key);
});

test('duo standings: stale rows with a reused team id never merge; a key never holds more than two rows', () => {
    // rows as the board makes them: tm is the formation key, solo rows have none.
    // Here one arras team id (-300) is reused by four bodies over a raid;
    // only the two that formed a pair share a key.
    const rows = [
        { id: 1, tm: 'd1', name: 'Dylan', score: 900, team: -300 },
        { id: 2, tm: 'd1', name: 'mini_ruby', score: 400, team: -300 },
        { id: 3, name: 'soggygold', score: 300, team: -300 },         // solo, dead, same old id
        { id: 4, name: 'carrot', score: 200, team: -300 },            // solo bot, same id
        { id: 5, tm: 'b7', name: 'BotA', score: 100 },
        { id: 6, tm: 'b7', name: 'BotB', score: 50 },
    ];
    const t = teamStandings(rows);
    assert.ok(t.every(x => x.rows.length <= 2));
    assert.deepEqual(t.find(x => x.tm === 'd1').rows.map(r => r.name), ['Dylan', 'mini_ruby']);
    assert.equal(t.filter(x => x.tm == null).length, 2, 'solo rows stand alone');
    // defensive cap: a bug that puts four rows on one key splits the extras
    const bad = teamStandings([
        { id: 1, tm: 'd9', name: 'A', score: 4 }, { id: 2, tm: 'd9', name: 'B', score: 3 },
        { id: 3, tm: 'd9', name: 'C', score: 2 }, { id: 4, tm: 'd9', name: 'D', score: 1 },
    ]);
    assert.ok(bad.every(x => x.rows.length <= 2));
    assert.equal(bad.length, 3);
    assert.deepEqual(bad[0].rows.map(r => r.name), ['A', 'B']);
});

// ---- HTTP ----

function server() {
    const s = http.createServer((req, res) => { if (!accounts.handleHttp(req, res)) { res.writeHead(418); res.end(); } });
    return new Promise(resolve => s.listen(0, '127.0.0.1', () => {
        const port = s.address().port;
        const base = `http://127.0.0.1:${port}`;
        const origin = 'http://localhost:3000';
        const call = async (method, p, body, cookie, guest, noOrigin) => {
            const headers = {};
            if (cookie) headers.Cookie = cookie;
            if (guest) headers['X-Party-Guest'] = guest;
            if (method !== 'GET') { headers['Content-Type'] = 'application/json'; if (!noOrigin) headers.Origin = origin; }
            const r = await fetch(base + p, { method, headers, body: method !== 'GET' ? JSON.stringify(body || {}) : undefined });
            const text = await r.text();
            let json = null;
            try { json = JSON.parse(text); } catch (e) { /* not json */ }
            return { status: r.status, json };
        };
        resolve({
            port,
            get: (p, cookie, guest) => call('GET', p, null, cookie, guest),
            post: (p, body, cookie, guest, noOrigin) => call('POST', p, body, cookie, guest, noOrigin),
            cookieFor: u => accounts.config.cookies.session + '=' + accounts.sessions.create(u.id, { now: Date.now() }).token,
            close: () => { s.closeAllConnections && s.closeAllConnections(); s.close(); },
        });
    }));
}

function sse(srv, cookie) {
    return new Promise((resolve, reject) => {
        const req = http.get({ host: '127.0.0.1', port: srv.port, path: '/api/events', headers: { Cookie: cookie } }, res => {
            if (res.statusCode !== 200) return reject(new Error('sse status ' + res.statusCode));
            let buf = '';
            const got = [];
            res.setEncoding('utf8');
            res.on('data', chunk => {
                buf += chunk;
                let k;
                while ((k = buf.indexOf('\n\n')) >= 0) {
                    const block = buf.slice(0, k);
                    buf = buf.slice(k + 2);
                    const ev = /^event: (.*)$/m.exec(block), data = /^data: (.*)$/m.exec(block);
                    if (ev && data) got.push({ event: ev[1], data: JSON.parse(data[1]) });
                }
            });
            resolve({
                next: async (type, pred = () => true, ms = 3000) => {
                    const end = Date.now() + ms;
                    while (Date.now() < end) {
                        const i = got.findIndex(f => f.event === type && pred(f.data));
                        if (i >= 0) return got.splice(i, 1)[0].data;
                        await new Promise(r => setTimeout(r, 25));
                    }
                    throw new Error('no ' + type + ' event');
                },
                close: () => req.destroy(),
            });
        });
        req.on('error', reject);
    });
}

let seq = 0;
function mkUser(prefix = 'duo') {
    const r = users.create({ username: prefix + (++seq) + 'x', recoveryHash: null, now: Date.now() - 86400000 });
    assert.ok(r.ok, 'user created');
    return users.byId(r.user.id);
}

test('http: guests team up by code, get tickets; errors and CSRF', async () => {
    party.reset();
    require('../../server/accounts/routes/party').start();
    const srv = await server();
    try {
        let r = await srv.get('/api/party');
        assert.deepEqual(r.json, { party: null, invites: [], you: null });
        r = await srv.post('/api/party/create', { name: 'Gus' }, null, null, true);
        assert.equal(r.status, 403, 'no Origin: refused');
        r = await srv.post('/api/party/create', { name: 'Gus' });
        assert.equal(r.status, 200);
        const t1 = r.json.guestToken, codeStr = r.json.party.code;
        assert.ok(t1 && t1.length >= 20);
        r = await srv.post('/api/party/join', { code: 'ZZZZZ', name: 'Gia' });
        assert.equal(r.status, 404);
        r = await srv.post('/api/party/join', { code: codeStr, name: 'Gia' });
        assert.equal(r.status, 200);
        const t2 = r.json.guestToken;
        assert.equal(r.json.party.full, true);
        r = await srv.get('/api/party', null, t1);
        assert.deepEqual(r.json.party.members.map(m => m.name), ['Gus', 'Gia']);
        assert.equal(r.json.you.guest, true);
        r = await srv.post('/api/party/launch', { fill: true }, null, t1);
        const v1 = ticket.verify(r.json.ticket);
        assert.ok(v1 && v1.mk.startsWith('g:') && v1.mates.length === 2);
        r = await srv.post('/api/party/ticket', {}, null, t2);
        const v2 = ticket.verify(r.json.ticket);
        assert.equal(v2.pid, v1.pid);
        assert.notEqual(v2.mk, v1.mk);
        r = await srv.post('/api/party/ticket', {}, null, 'not-a-real-token-at-all-000');
        assert.equal(r.status, 404, 'unknown guest token: not in a party');
        r = await srv.post('/api/party/invite', { userId: 'DW-NOPE' }, null, t1);
        assert.equal(r.status, 401, 'guests cannot invite');
        r = await srv.post('/api/party/leave', {}, null, t2);
        r = await srv.get('/api/party', null, t1);
        assert.equal(r.json.party.members.length, 1);
        // guessing codes gets rate limited
        let limited = false;
        for (let i = 0; i < 30 && !limited; i++) {
            r = await srv.post('/api/party/join', { code: 'QQQQ' + 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[i], name: 'x' });
            if (r.status === 429) limited = true;
        }
        assert.ok(limited, 'wrong codes hit the partyCode limit');
    } finally { srv.close(); }
});

test('http + SSE: account invites a friend on the menu, accept, launch reaches the mate', async () => {
    party.reset();
    require('../../server/accounts/routes/party').start();
    const srv = await server();
    const a = mkUser(), b = mkUser(), c = mkUser(), off = mkUser();
    const friends = accounts.friends;
    for (const x of [b, c, off]) { friends.request(a.id, x.username, Date.now()); friends.respond(x.id, a, true, Date.now()); }
    const ca = srv.cookieFor(a), cb = srv.cookieFor(b), cc = srv.cookieFor(c);
    let sa = null, sb = null;
    try {
        sa = await sse(srv, ca); sb = await sse(srv, cb);
        await sa.next('hello'); await sb.next('hello');
        let r = await srv.post('/api/party/invite', { userId: off.public_id }, ca);
        assert.equal(r.json.error.code, 'offline');
        presence.join('duo', c.id, 'sock1');
        r = await srv.post('/api/party/invite', { userId: c.public_id }, ca);
        assert.equal(r.status, 200, 'a friend in a raid can be invited (an in-game card, they join after)');
        assert.equal(r.json.party.pending[0].to, c.username);
        r = await srv.post('/api/party/invite/cancel', { id: r.json.invite.id }, ca);
        assert.equal(r.status, 200);
        assert.equal(r.json.party.pending.length, 0, 'taken back');
        const stranger = mkUser();
        r = await srv.post('/api/party/invite', { userId: stranger.public_id }, ca);
        assert.equal(r.json.error.code, 'not_friends');
        r = await srv.post('/api/party/invite', { userId: b.public_id }, ca);
        assert.equal(r.status, 200);
        assert.equal(r.json.party.pending[0].to, b.username);
        const inv = await sb.next('partyInvite');
        assert.equal(inv.from.username, a.username);
        r = await srv.get('/api/party', cb);
        assert.equal(r.json.invites.length, 1, 'GET shows the invite too (polling fallback)');
        r = await srv.post('/api/party/respond', { id: inv.id, accept: true }, cb);
        assert.equal(r.json.party.members.length, 2);
        const joined = await sa.next('party', d => d.why === 'join');
        assert.equal(joined.who, b.username);
        r = await srv.post('/api/party/launch', { fill: true }, ca);
        assert.equal(ticket.verify(r.json.ticket).mk, 'u:' + a.id);
        const launched = await sb.next('party', d => d.why === 'launch');
        assert.equal(launched.party.launch.seq, 1);
        assert.equal(launched.party.launch.byYou, false);
        // blocking: a blocked friend can't be invited
        friends.block(c.id, a, Date.now());
        presence.leave('duo', c.id, 'sock1');
        r = await srv.post('/api/party/invite', { userId: c.public_id }, ca);
        assert.equal(r.status, 403);
        // leave: the mate hears it
        r = await srv.post('/api/party/leave', {}, cb);
        const left = await sa.next('party', d => d.why === 'left');
        assert.equal(left.party.members.length, 1);
        void cc;
    } finally {
        if (sa) sa.close();
        if (sb) sb.close();
        srv.close();
    }
});

async function main() {
    const log = console.log, warn = console.warn;
    console.log = (...a) => { if (!String(a[0]).startsWith('[accounts]')) log(...a); };
    console.warn = (...a) => { if (!String(a[0]).startsWith('[accounts]')) warn(...a); };
    assert.equal(accounts.initMain(), true, 'initMain');
    let failed = 0;
    const t0 = Date.now();
    for (const t of tests) {
        const started = Date.now();
        accounts.ratelimit.reset();
        try {
            await t.fn();
            log(`ok   ${t.name} (${Date.now() - started} ms)`);
        } catch (e) {
            failed++;
            log(`FAIL ${t.name}\n     ${((e && e.stack) || e).toString().split('\n').slice(0, 6).join('\n     ')}`);
        }
    }
    party.stop();
    accounts.shutdown();
    log(`\n${tests.length - failed}/${tests.length} passed in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    if (!failed) fs.rmSync(ROOT, { recursive: true, force: true });
    else log('test data kept in ' + ROOT);
    process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
