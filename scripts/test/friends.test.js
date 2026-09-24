// Friends / presence / profile / leaderboard tests (Phase 4):
//   node scripts/test/friends.test.js
//
// The rules in server/accounts/friends.js and presence.js against a
// throwaway database, plus a bare-HTTP pass over the routes and one SSE
// stream. No game server. Data goes under $DATA_DIR if set, otherwise the OS
// temp dir; it is removed when everything passes.
'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const ROOT = process.env.DATA_DIR
    ? path.join(process.env.DATA_DIR, `friends-test-${process.pid}-${Date.now()}`)
    : fs.mkdtempSync(path.join(os.tmpdir(), 'dw-friends-test-'));
process.env.DATA_DIR = path.join(ROOT, 'data');
delete process.env.DB_PATH;
delete process.env.PUBLIC_HOST;
delete process.env.PUBLIC_ORIGIN;
delete process.env.ALLOWED_ORIGINS;
process.env.NODE_ENV = 'test';
process.env.ACCOUNTS_ENABLED = 'true';
process.env.SESSION_SECRET = 'friends-test-secret-0123456789-abcdefghijklmnop';

const R = require('../../shared/ranks.js');
const accounts = require('../../server/accounts');
const friends = require('../../server/accounts/friends');
const presence = require('../../server/accounts/presence');
const events = require('../../server/accounts/routes/events');
const profile = require('../../server/accounts/routes/profile');
const store = require('../../server/accounts/store');
const users = accounts.users;

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
const d = () => accounts.db.handle();

let seq = 0;
function mkUser(prefix = 'pal') {
    const r = users.create({ username: prefix + (++seq) + 'x', recoveryHash: null, now: NOW - 10 * DAY });
    assert.ok(r.ok, 'user created');
    return users.byId(r.user.id);
}
function code(fn) {
    try { fn(); } catch (e) { return e.status + ':' + e.code; }
    return 'ok';
}
const ids = list => list.map(r => r.id).sort((a, b) => a - b);

// ---- requests ----

test('request -> incoming/outgoing -> accept makes friends both ways', () => {
    const a = mkUser(), b = mkUser();
    const r = friends.request(a.id, b.username.toUpperCase(), NOW);
    assert.equal(r.status, 'pending');
    assert.deepEqual(r.notify, { type: 'friendRequest', to: b.id });
    assert.equal(friends.request(a.id, b.username, NOW).status, 'pending', 'repeat is idempotent');
    assert.deepEqual(ids(friends.lists(b.id).incoming), [a.id]);
    assert.deepEqual(ids(friends.lists(a.id).outgoing), [b.id]);
    assert.equal(code(() => friends.respond(a.id, b, true, NOW)), '404:no_request', 'only the recipient can answer');
    assert.equal(friends.respond(b.id, a, true, NOW).status, 'accepted');
    assert.ok(friends.areFriends(a.id, b.id) && friends.areFriends(b.id, a.id));
    assert.deepEqual(ids(friends.lists(a.id).friends), [b.id]);
    assert.equal(friends.lists(a.id).outgoing.length + friends.lists(b.id).incoming.length, 0);
    assert.equal(code(() => friends.request(a.id, b.username, NOW)), '409:already_friends');
    assert.equal(code(() => friends.request(a.id, a.username, NOW)), '400:self');
    assert.equal(code(() => friends.request(a.id, 'nobody_here_x', NOW)), '404:user_not_found');
    friends.remove(b.id, a);
    assert.ok(!friends.areFriends(a.id, b.id));
    assert.equal(code(() => friends.remove(b.id, a)), '404:not_friends');
});

test('request back to someone who already asked auto-accepts; decline and cancel', () => {
    const a = mkUser(), b = mkUser(), c = mkUser();
    friends.request(a.id, b.username, NOW);
    const r = friends.request(b.id, a.username, NOW);
    assert.equal(r.status, 'accepted');
    assert.deepEqual(r.notify, { type: 'friendAccepted', to: a.id });
    assert.ok(friends.areFriends(a.id, b.id));
    assert.equal(d().get('SELECT count(*) AS n FROM friend_requests WHERE from_id IN (?, ?)', a.id, b.id).n, 0);

    friends.request(c.id, a.username, NOW);
    assert.equal(friends.respond(a.id, c, false, NOW).status, 'declined');
    assert.ok(!friends.areFriends(a.id, c.id));
    friends.request(c.id, a.username, NOW);
    assert.equal(friends.cancel(c.id, a).silent, false);
    assert.equal(friends.lists(a.id).incoming.length, 0);
    assert.equal(code(() => friends.cancel(c.id, a)), '404:no_request');
});

// ---- blocks ----

test('block: removes friendship + requests both ways; blocker cannot request; blocked is silent', () => {
    const a = mkUser(), b = mkUser(), c = mkUser();
    friends.request(a.id, b.username, NOW);
    friends.respond(b.id, a, true, NOW);
    friends.request(a.id, c.username, NOW);
    friends.request(c.id, b.username, NOW);
    const r1 = friends.block(a.id, b, NOW);
    assert.equal(r1.wasFriend, true);
    assert.ok(!friends.areFriends(a.id, b.id));
    const r2 = friends.block(c.id, a, NOW);
    assert.equal(r2.hadIncoming, true, 'a -> c request removed');
    assert.equal(d().get('SELECT count(*) AS n FROM friend_requests WHERE (from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?)', a.id, c.id, c.id, a.id).n, 0);

    // blocker can't request; the blocked one "succeeds" silently
    assert.equal(code(() => friends.request(a.id, b.username, NOW)), '409:you_blocked');
    const s = friends.request(b.id, a.username, NOW);
    assert.equal(s.status, 'pending');
    assert.equal(s.notify, null, 'no event to the blocker');
    assert.deepEqual(ids(friends.lists(b.id).outgoing), [a.id], 'looks pending from the blocked side');
    assert.equal(friends.lists(a.id).incoming.length, 0, 'never shown to the blocker');
    assert.equal(code(() => friends.respond(a.id, b, true, NOW)), '404:no_request');

    // either direction for chat, gifts and profiles
    assert.ok(friends.blockSet(a.id).has(b.id) && friends.blockSet(b.id).has(a.id));
    assert.ok(friends.blockedEitherWay(b.id, a.id));
    assert.deepEqual(ids(friends.lists(a.id).blocked), [b.id]);
    // blocked even with an old friendship row can't gift
    d().run('INSERT INTO friendships (user_lo, user_hi, created_at) VALUES (?, ?, ?)', Math.min(a.id, b.id), Math.max(a.id, b.id), NOW - 5 * DAY);
    const item = store.rotationFor(Math.floor(NOW / DAY), 2, NOW).daily[0];
    d().run('UPDATE users SET dust_milli = 10000000 WHERE id = ?', b.id);
    assert.equal(code(() => store.gift(b.id, { itemId: item, day: Math.floor(NOW / DAY), toUserId: a.public_id, idempotencyKey: 'gift-key-0001' }, { now: NOW })), '403:not_friends');
    d().run('DELETE FROM friendships WHERE user_lo = ? AND user_hi = ?', Math.min(a.id, b.id), Math.max(a.id, b.id));

    friends.unblock(a.id, b);
    assert.ok(!friends.hasBlocked(a.id, b.id));
    assert.equal(code(() => friends.unblock(a.id, b)), '404:not_blocked');
});

// ---- limits ----

test('limits: 50 outgoing requests, 200 friends (either side)', () => {
    const a = mkUser('lim');
    const others = Array.from({ length: 51 }, () => mkUser('tgt'));
    for (let i = 0; i < 50; i++) friends.request(a.id, others[i].username, NOW);
    assert.equal(friends.outgoingCount(a.id), 50);
    assert.equal(code(() => friends.request(a.id, others[50].username, NOW)), '409:outgoing_limit');

    const full = mkUser('full'), x = mkUser(), y = mkUser();
    for (let i = 0; i < 200; i++) {
        const u = users.create({ username: 'fz' + i + 'q' + seq, recoveryHash: null, now: NOW }).user;
        d().run('INSERT INTO friendships (user_lo, user_hi, created_at) VALUES (?, ?, ?)', Math.min(full.id, u.id), Math.max(full.id, u.id), NOW);
    }
    assert.equal(friends.friendCount(full.id), 200);
    assert.equal(code(() => friends.request(full.id, y.username, NOW)), '409:friend_limit');
    friends.request(x.id, full.username, NOW);
    assert.equal(code(() => friends.respond(full.id, x, true, NOW)), '409:friend_limit');
    assert.equal(code(() => friends.request(full.id, x.username, NOW)), '409:friend_limit', 'auto-accept checks too');
    d().run('INSERT INTO friend_requests (from_id, to_id, created_at) VALUES (?, ?, ?)', full.id, y.id, NOW);
    assert.equal(code(() => friends.respond(y.id, full, true, NOW)), '409:their_friend_limit');
    assert.equal(friends.friendCount(full.id), 200);
});

// ---- presence ----

test('presence: raid from the game bus, menu from streams, offline with last seen; status is authoritative', () => {
    presence.reset();
    const a = mkUser();
    const seen = [];
    const off = presence.onChange((id, p) => { if (id === a.id) seen.push(p.state + (p.score != null ? ':' + p.score : '')); });
    try {
        assert.equal(presence.get(a.id).state, 'offline');
        presence.streamOpened(a.id, NOW);
        assert.equal(presence.get(a.id).state, 'menu');
        presence.onBus('w1', { t: 'join', userId: a.id, sid: 's1' }, NOW + 1);
        assert.equal(presence.get(a.id).state, 'raid');
        presence.onBus('w1', { t: 'status', players: [{ userId: a.id, sid: 's1', alive: true, score: 120, place: 3, rank: 5 }] }, NOW + 2);
        let p = presence.get(a.id);
        assert.deepEqual([p.state, p.alive, p.score, p.place], ['raid', true, 120, 3]);
        // score pushes are throttled to one per 15 s
        presence.onBus('w1', { t: 'status', players: [{ userId: a.id, sid: 's1', alive: true, score: 150, place: 2 }] }, NOW + 5000);
        presence.onBus('w1', { t: 'status', players: [{ userId: a.id, sid: 's1', alive: true, score: 180, place: 1 }] }, NOW + 20000);
        assert.deepEqual(seen, ['menu', 'raid', 'raid:180']);
        // an empty status from that server drops the socket (missed leave)
        presence.onBus('w1', { t: 'status', players: [] }, NOW + 21000);
        assert.equal(presence.get(a.id).state, 'menu');
        presence.streamClosed(a.id, NOW + 22000);
        p = presence.get(a.id);
        assert.equal(p.state, 'offline');
        assert.equal(p.lastSeen, NOW + 22000);
        assert.equal(users.byId(a.id).last_seen_at, NOW + 22000);
        // join/leave, and a server that goes silent is dropped
        presence.onBus('w2', { t: 'join', userId: a.id, sid: 's2' }, NOW + 23000);
        presence.onBus('w2', { t: 'leave', userId: a.id, sid: 's2' }, NOW + 24000);
        assert.equal(presence.get(a.id).state, 'offline');
        presence.onBus('w3', { t: 'join', userId: a.id, sid: 's3' }, NOW + 25000);
        presence.sweepStale(NOW + 25000 + presence.STALE_SERVER_MS + 1);
        assert.equal(presence.get(a.id).state, 'offline');
    } finally { off(); presence.reset(); }
});

// ---- leaderboard / profile helpers ----

test('leaderboard: ranked only, rp order, Legend #N, deleted/banned out, own row', () => {
    d().run('UPDATE users SET ranked_at = NULL, rp = 0, legend_at = NULL');
    const legendFloor = R.DIVISIONS[R.LEGEND].floor;
    const u = Array.from({ length: 6 }, () => mkUser('lb'));
    accounts.rankStore.debugSetRp(u[0].id, 500, NOW);
    accounts.rankStore.debugSetRp(u[1].id, legendFloor + 100, NOW - 1000);
    accounts.rankStore.debugSetRp(u[2].id, legendFloor + 100, NOW - 5000);   // same rp, Legend earlier -> ahead
    accounts.rankStore.debugSetRp(u[3].id, legendFloor + 9000, NOW);
    accounts.rankStore.debugSetRp(u[4].id, 1e7, NOW);
    d().run('UPDATE users SET deleted_at = ? WHERE id = ?', NOW, u[4].id);          // deleted: out
    d().run('UPDATE users SET placement_lives = 1 WHERE id = ?', u[5].id);          // unranked: out
    profile.clearCache();
    return (async () => {
        const srv = await server();
        try {
            const r = await srv.get('/api/leaderboard');
            assert.equal(r.status, 200);
            const names = r.json.rows.map(x => x.username);
            assert.deepEqual(names, [u[3], u[2], u[1], u[0]].map(x => x.username));
            assert.deepEqual(r.json.rows.map(x => x.legendNo), [1, 2, 3, 0]);
            assert.deepEqual(r.json.rows.map(x => x.place), [1, 2, 3, 4]);
            assert.equal(r.json.rows[0].tier, 'legend');
            assert.equal(r.json.me, null, 'guest');
            const me = await srv.get('/api/leaderboard?limit=2', srv.cookieFor(u[1]));
            assert.equal(me.json.rows.length, 2);
            assert.deepEqual([me.json.me.place, me.json.me.legendNo, me.json.me.userId], [3, 3, u[1].public_id]);
            // cached for 60 s: a new leader does not show until the cache clears
            accounts.rankStore.debugSetRp(u[0].id, legendFloor + 99999, NOW);
            assert.equal((await srv.get('/api/leaderboard')).json.rows[0].username, u[3].username);
            profile.clearCache();
            assert.equal((await srv.get('/api/leaderboard')).json.rows[0].username, u[0].username);
        } finally { srv.close(); }
    })();
});

// ---- HTTP + SSE ----

function server() {
    const s = http.createServer((req, res) => { if (!accounts.handleHttp(req, res)) { res.writeHead(418); res.end(); } });
    return new Promise(resolve => s.listen(0, '127.0.0.1', () => {
        const port = s.address().port;
        const base = `http://127.0.0.1:${port}`;
        const origin = 'http://localhost:' + port;
        const call = async (method, p, body, cookie) => {
            const headers = {};
            if (cookie) headers.Cookie = cookie;
            if (method !== 'GET') { headers['Content-Type'] = 'application/json'; headers.Origin = origin; }
            const r = await fetch(base + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
            const text = await r.text();
            let json = null;
            try { json = JSON.parse(text); } catch (e) { /* not json */ }
            return { status: r.status, json };
        };
        resolve({
            base, port,
            get: (p, cookie) => call('GET', p, null, cookie),
            post: (p, body, cookie) => call('POST', p, body, cookie),
            cookieFor: u => accounts.config.cookies.session + '=' + accounts.sessions.create(u.id, { now: Date.now() }).token,
            close: () => { s.closeAllConnections && s.closeAllConnections(); s.close(); },
        });
    }));
}

// Reads SSE frames off a raw http request. -> {next(type), close()}
function sse(srv, cookie) {
    return new Promise((resolve, reject) => {
        const req = http.get({ host: '127.0.0.1', port: srv.port, path: '/api/events', headers: { Cookie: cookie } }, res => {
            if (res.statusCode !== 200) return reject(new Error('sse status ' + res.statusCode));
            let buf = '';
            const got = [];
            const waiters = [];
            const pump = () => {
                for (let i = 0; i < waiters.length; i++) {
                    const w = waiters[i];
                    const j = got.findIndex(f => f.event === w.type);
                    if (j >= 0) { waiters.splice(i--, 1); clearTimeout(w.t); w.resolve(got.splice(j, 1)[0].data); }
                }
            };
            res.setEncoding('utf8');
            res.on('data', chunk => {
                buf += chunk;
                let k;
                while ((k = buf.indexOf('\n\n')) >= 0) {
                    const block = buf.slice(0, k);
                    buf = buf.slice(k + 2);
                    const ev = /^event: (.*)$/m.exec(block), data = /^data: (.*)$/m.exec(block);
                    if (ev && data) got.push({ event: ev[1], data: JSON.parse(data[1]) });
                    else if (/^retry: 5000$/m.test(block)) got.push({ event: 'retry', data: 5000 });
                }
                pump();
            });
            resolve({
                headers: res.headers,
                next: (type, ms = 3000) => new Promise((ok, bad) => {
                    const w = { type, resolve: ok, t: setTimeout(() => bad(new Error('no ' + type + ' event')), ms) };
                    waiters.push(w);
                    pump();
                }),
                close: () => req.destroy(),
            });
        });
        req.on('error', reject);
    });
}

test('http + SSE: friends routes, events, profile 404 when blocked, rank-up toast, rate limit', async () => {
    const srv = await server();
    const a = mkUser('web'), b = mkUser('web');
    const ca = srv.cookieFor(a), cb = srv.cookieFor(b);
    let s = null;
    try {
        assert.equal((await srv.get('/api/friends')).status, 401);
        assert.equal((await srv.get('/api/events')).status, 401);
        s = await sse(srv, ca);
        assert.match(s.headers['content-type'], /text\/event-stream/);
        assert.equal(await s.next('retry'), 5000);
        const hello = await s.next('hello');
        assert.deepEqual([hello.friends, hello.incoming, hello.outgoing, hello.blocked], [[], [], [], []]);
        assert.equal(presence.get(a.id).state, 'menu');

        let r = await srv.post('/api/friends/request', { username: a.username }, cb);
        assert.equal(r.status, 200);
        assert.equal(r.json.status, 'pending');
        const fr = await s.next('friendRequest');
        assert.deepEqual([fr.userId, fr.username], [b.public_id, b.username]);
        assert.deepEqual(fr.rank, { division: null, name: 'Unranked', tier: null });

        r = await srv.post('/api/friends/respond', { userId: b.public_id, accept: true }, ca);
        assert.equal(r.json.status, 'accepted');
        assert.equal(r.json.friend.userId, b.public_id);
        assert.equal(r.json.friend.presence.state, 'offline');
        const list = (await srv.get('/api/friends', ca)).json;
        assert.equal(list.friends.length, 1);
        assert.deepEqual(Object.keys(list.friends[0]).sort(), ['presence', 'rank', 'since', 'userId', 'username']);

        // b comes online in a raid -> a gets a coalesced presence update
        presence.onBus('main', { t: 'join', userId: b.id, sid: 'x1' });
        presence.onBus('main', { t: 'status', players: [{ userId: b.id, sid: 'x1', alive: true, score: 42, place: 2 }] });
        events.flushPresence();
        const pu = await s.next('presence');
        assert.equal(pu.updates.length, 1, 'coalesced to one entry per friend');
        assert.deepEqual([pu.updates[0].userId, pu.updates[0].state], [b.public_id, 'raid']);

        // rank-up from the game -> toast to friends with the menu open
        accounts.bus.fromGame('main', { t: 'rankUp', userId: b.id, division: 3, tierUp: true });
        const ru = await s.next('friendRankUp');
        assert.deepEqual([ru.userId, ru.division, ru.tier, ru.tierUp], [b.public_id, 3, 'silver', true]);

        // profiles: fine as friends, 404 both ways once blocked
        r = await srv.get('/api/profile?u=' + encodeURIComponent(b.username), ca);
        assert.equal(r.status, 200);
        assert.equal(r.json.relation, 'friend');
        assert.deepEqual(Object.keys(r.json.stats).sort(), ['bestLife', 'gemsBanked', 'kills', 'lives', 'raidWins', 'top3']);
        assert.ok(Array.isArray(r.json.achievements) && Array.isArray(r.json.tiers));
        assert.equal((await srv.get('/api/profile?u=' + a.public_id, ca)).json.relation, 'self');
        r = await srv.post('/api/friends/block', { username: a.username }, cb);
        assert.equal(r.status, 200);
        assert.equal(r.json.blocked.userId, a.public_id);
        assert.equal((await s.next('friendRemoved')).userId, b.public_id);
        assert.equal((await srv.get('/api/profile?u=' + b.public_id, ca)).status, 404);
        assert.equal((await srv.get('/api/profile?u=' + a.username, cb)).status, 404);
        assert.equal((await srv.get('/api/profile?u=nobody_at_all', ca)).status, 404);

        // in-game chat filter reads the same block set, either way
        const bridge = require('../../server/accounts/game/bridge');
        const viewer = { account: { id: a.id, blocked: friends.blockSet(a.id) } };
        assert.equal(bridge.chatHidden(viewer, { accountId: b.id }), true);
        assert.equal(bridge.chatHidden(viewer, { accountId: 0 }), false);

        // a revoked session ends its stream
        d().run('DELETE FROM sessions WHERE user_id = ?', a.id);
        events.checkSessions(a.id);
        await s.next('sessionRevoked');

        // 20 friend requests an hour
        const c = mkUser('rl'), cc = srv.cookieFor(c);
        let last = 0;
        for (let i = 0; i < 21; i++) last = (await srv.post('/api/friends/request', { username: 'ghost_' + i }, cc)).status;
        assert.equal(last, 429);
    } finally {
        if (s) s.close();
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
    accounts.shutdown();
    log(`\n${tests.length - failed}/${tests.length} passed in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    if (!failed) fs.rmSync(ROOT, { recursive: true, force: true });
    else log('test data kept in ' + ROOT);
    process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
