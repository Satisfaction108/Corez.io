'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');

const REPO = path.join(__dirname, '..', '..');
const read = (...p) => fs.readFileSync(path.join(REPO, ...p), 'utf8');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-noduo-test-'));
process.env.DATA_DIR = path.join(ROOT, 'data');
for (const k of ['DB_PATH', 'PUBLIC_HOST', 'PUBLIC_ORIGIN', 'ALLOWED_ORIGINS', 'PARTY_TICKET_SECRET']) delete process.env[k];
process.env.NODE_ENV = 'test';
process.env.ACCOUNTS_ENABLED = 'true';
process.env.SESSION_SECRET = 'noduo-test-secret-0123456789-abcdefghijklmnop';

const accounts = require('../../server/accounts');
const gone = require('../../server/accounts/routes/duosRemoved');
const TEXT = 'Duos has been removed. Press Play to join a solo game.';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

function server() {
    const s = http.createServer((req, res) => { if (!accounts.handleHttp(req, res)) { res.writeHead(418); res.end(); } });
    return new Promise(resolve => s.listen(0, '127.0.0.1', () => {
        const base = 'http://127.0.0.1:' + s.address().port;
        const call = async (method, p, body, cookie, noOrigin) => {
            const headers = {};
            if (cookie) headers.Cookie = cookie;
            if (method !== 'GET') { headers['Content-Type'] = 'application/json'; if (!noOrigin) headers.Origin = 'http://localhost:3000'; }
            const r = await fetch(base + p, { method, headers, body: method !== 'GET' ? JSON.stringify(body || {}) : undefined });
            let json = null;
            try { json = JSON.parse(await r.text()); } catch (e) { json = null; }
            return { status: r.status, json };
        };
        resolve({
            get: (p, cookie) => call('GET', p, null, cookie),
            post: (p, body, cookie, noOrigin) => call('POST', p, body, cookie, noOrigin),
            close: () => { if (s.closeAllConnections) s.closeAllConnections(); s.close(); },
        });
    }));
}

test('config: no duo server, and the overflow raids keep their ports', () => {
    const ids = (env) => JSON.parse(execFileSync(process.execPath, ['-e', "const c=require('./server/config.js');console.log(JSON.stringify(c.servers.map(s=>[s.id,s.port,!!(s.properties&&s.properties.royale_duos)])))"], { cwd: REPO, env: Object.assign({}, process.env, env) }).toString());
    const dev = ids({ NODE_ENV: 'development', SOLO_RAIDS: '1' });
    assert.deepEqual(dev.map(r => r[0]), ['br', 'tut']);
    const prod = ids({ NODE_ENV: 'production', SOLO_RAIDS: '' });
    assert.deepEqual(prod.map(r => r[0] + ':' + r[1]), ['br:3100', 'tut:3101', 'br2:3103', 'br3:3104', 'br4:3105']);
    assert.ok(prod.every(r => !r[2]), 'no royale_duos anywhere');
});

test('http: the party API answers old clients with the friendly line', async () => {
    assert.equal(gone.TEXT, TEXT);
    const srv = await server();
    try {
        let r = await srv.get('/api/party');
        assert.equal(r.status, 200);
        assert.equal(r.json.party, null);
        assert.deepEqual(r.json.invites, []);
        assert.equal(r.json.removed, true);
        assert.equal(r.json.message, TEXT);
        for (const p of ['/api/party/create', '/api/party/join', '/api/party/launch', '/api/party/ticket', '/api/party/invite', '/api/party/respond', '/api/party/invite/cancel']) {
            r = await srv.post(p, { code: 'ABCDE', fill: true });
            assert.equal(r.status, 410, p);
            assert.equal(r.json.error.code, 'duos_removed', p);
            assert.equal(r.json.error.message, TEXT, p);
        }
        r = await srv.post('/api/party/leave', {});
        assert.equal(r.status, 200);
        assert.equal(r.json.party, null);
        r = await srv.post('/api/party/create', {}, null, true);
        assert.equal(r.status, 403, 'still behind the CSRF guard');
    } finally { srv.close(); }
});

test('http: friends still work', async () => {
    const srv = await server();
    try {
        const mk = (n) => { const r = accounts.users.create({ username: n, recoveryHash: null, now: Date.now() - 86400000 }); assert.ok(r.ok); return accounts.users.byId(r.user.id); };
        const a = mk('noduoA' + (Date.now() % 1000)), b = mk('noduoB' + (Date.now() % 1000));
        const cookie = (u) => accounts.config.cookies.session + '=' + accounts.sessions.create(u.id, { now: Date.now() }).token;
        let r = await srv.get('/api/friends', cookie(a));
        assert.equal(r.status, 200);
        r = await srv.post('/api/friends/request', { username: b.username }, cookie(a));
        assert.ok(r.status === 200 || r.status === 201, 'friend request ' + r.status + ' ' + JSON.stringify(r.json));
        r = await srv.get('/api/friends', cookie(b));
        assert.equal(r.status, 200);
        assert.equal(JSON.stringify(r.json).includes(a.username), true, 'b sees the request');
    } finally { srv.close(); }
});

test('server.js: /duo closes with the friendly line instead of proxying', () => {
    const s = read('server', 'server.js');
    assert.match(s, /DUOS_REMOVED_TEXT = require\("\.\/accounts\/routes\/duosRemoved\.js"\)\.TEXT/);
    assert.match(s, /url === DUO_PROXY_PATH[\s\S]{0,200}handleUpgrade[\s\S]{0,120}ws\.close\(4001, DUOS_REMOVED_TEXT\)/);
    assert.ok(!/workerPort\("duo"\)/.test(s), 'no duo worker port');
    assert.ok(!/royale_duos/.test(s), 'the server list has no duo row');
    const si = read('public', 'client', 'socketinit.js');
    assert.match(si, /ev\.code === IDLE_CLOSE_CODE && global\.gameLoading\) \{ idleExit\(ev\.reason/, 'old clients show the close reason on the menu');
    const idx = read('server', 'accounts', 'index.js');
    assert.ok(!/partyRoutes|partyTicket'\)\.initMain/.test(idx), 'the party store and tickets never start');
    assert.match(idx, /ratelimit\.start\(\)/, 'rate limits still start');
});

test('client: the home card has no Solo or Duos picker and Play always goes solo', () => {
    const html = read('public', 'index.html');
    for (const re of [/id="modeToggle"/, /id="duoPanel"/, />Duos</, /duo invite/i, /ping your duo/i, /Fill with a random teammate/]) assert.ok(!re.test(html), String(re));
    assert.match(html, /<div class="menu-row region-row">/);
    const main = read('public', 'client', 'account', 'main.js');
    assert.ok(!/party\.js|party\.init/.test(main), 'main.js no longer loads the party UI');
    const fp = read('public', 'client', 'account', 'friendsPane.js');
    assert.ok(!/duoBtn|party\.js|Invite to duo/.test(fp), 'no invite to duo in the friends list');
    const app = read('public', 'client', 'app.js');
    assert.ok(!/dwParty|duoArmed|duoSession/.test(app), 'startGame never arms a duo');
    assert.ok(!/duoSession/.test(read('public', 'client', 'socketinit.js')), 'no DQ hello');
    const css = read('public', 'home.css');
    assert.ok(!/\.duo-panel|\.duo-slot|\.duo-fill|\.mode-row/.test(css), 'no duo menu styles left');
    for (const f of [['public', 'about.html'], ['public', 'devlog.html']]) assert.ok(!/duo/i.test(read(...f)), f.join('/'));
    assert.ok(fs.existsSync(path.join(REPO, 'public', 'client', 'account', 'party.js')), 'party.js is kept for an easy undo');
    assert.ok(fs.existsSync(path.join(REPO, 'server', 'accounts', 'routes', 'party.js')));
    assert.ok(fs.existsSync(path.join(REPO, 'server', 'game', 'duo', 'duoRaid.js')));
});

test('saves: an old Duos save code still restores in Solo', () => {
    const saves = accounts.saves || require('../../server/accounts/saves');
    const u = accounts.users.create({ username: 'noduoS' + (Date.now() % 1000), recoveryHash: null, now: Date.now() - 86400000 });
    const t = Date.now();
    const made = saves.create({ mode: 'duo', userId: u.user.id, data: { pts: 77 } }, t);
    const r = saves.restore({ code: made.code, mode: 'solo', userId: u.user.id, ip: '198.51.100.9' }, t + 1000);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.data.pts, 77);
});

async function main() {
    const log = console.log;
    console.log = (...a) => { if (!String(a[0]).startsWith('[accounts]')) log(...a); };
    assert.equal(accounts.initMain(), true, 'initMain');
    let failed = 0;
    for (const t of tests) {
        accounts.ratelimit.reset();
        try { await t.fn(); log('ok   ' + t.name); }
        catch (e) { failed++; log('FAIL ' + t.name + '\n     ' + String((e && e.stack) || e).split('\n').slice(0, 6).join('\n     ')); }
    }
    accounts.shutdown();
    log(`\n${tests.length - failed}/${tests.length} passed`);
    if (!failed) fs.rmSync(ROOT, { recursive: true, force: true });
    process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
