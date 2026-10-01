// Domain move (corez.games -> corez.io): node scripts/test/domainMove.test.js
//
//   page      the moving page only answers page loads on the old host;
//             API, assets, sockets and the new host are untouched
//   handoff   move + claim round trip: localStorage, the session cookie and
//             dw_dev reach the new host; codes are one-time, expire, and are
//             capped in size; origins and hosts are checked both ways
//   client    the moving page's script and index.html's claim script, run in
//             a vm against this server: existing keys are kept, the hash is
//             stripped, one reload, no loop once dwMoved is set
//   config    MOVE_FROM_HOST parsing, allowed origins, Discord redirect
//
// Data goes under $DATA_DIR if set, otherwise the OS temp dir; it is removed
// when everything passes.
'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const vm = require('vm');

const ROOT = process.env.DATA_DIR
    ? path.join(process.env.DATA_DIR, `move-test-${process.pid}-${Date.now()}`)
    : fs.mkdtempSync(path.join(os.tmpdir(), 'dw-move-test-'));
const DATA_DIR = path.join(ROOT, 'data');

const OLD = 'old.test', NEW = 'new.test';
const OLD_ORIGIN = 'http://' + OLD, NEW_ORIGIN = 'http://' + NEW;
const UA = 'Mozilla/5.0 move-test';

process.env.DATA_DIR = DATA_DIR;
for (const k of ['DB_PATH', 'PUBLIC_HOST', 'ALLOWED_ORIGINS', 'ROYALE_DEBUG', 'ACCOUNTS_ALLOW_DEBUG', 'DISCORD_BOT_TOKEN',
    'DISCORD_REDIRECT_URI', 'BACKUP_ENCRYPTION_KEY', 'TRUSTED_PROXIES']) delete process.env[k];
Object.assign(process.env, {
    NODE_ENV: 'test', ACCOUNTS_ENABLED: 'true', SESSION_SECRET: 'move-test-secret-0123456789-abcdefghijkl',
    PUBLIC_ORIGIN: NEW_ORIGIN, MOVE_FROM_HOST: OLD, PORT: '3000',
    DISCORD_CLIENT_ID: '123456789012345678', DISCORD_CLIENT_SECRET: 'discord-test-secret',
});

const accounts = require('../../server/accounts');
const move = require('../../server/accounts/routes/move');
const config = accounts.config;

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
let seq = 0;
function mkUser() {
    const r = accounts.users.create({ username: ('mv_' + (++seq) + '_' + Math.floor(Math.random() * 1e4)).slice(0, 16), recoveryHash: null });
    assert.ok(r.ok, JSON.stringify(r));
    return r.user;
}
const tokenFor = user => accounts.sessions.create(user.id, { method: 'password' }).token;
const devValue = user => /dw_dev=([^;]+)/.exec(accounts.sessions.deviceCookie(user.id))[1];

// ---- HTTP, with any Host header ----
let port = 0;
let ipSeq = 0;
const freshIp = () => `10.7.${Math.floor(++ipSeq / 250)}.${(ipSeq % 250) + 1}`;
function request(method, url, { host = OLD, headers = {}, body = null, ip = null } = {}) {
    return new Promise((resolve, reject) => {
        const h = { Host: host, 'User-Agent': UA, 'X-Forwarded-For': ip || freshIp(), ...headers };
        let payload = null;
        if (body != null) {
            payload = typeof body === 'string' ? body : JSON.stringify(body);
            h['Content-Type'] = h['Content-Type'] || 'application/json';
            h['Content-Length'] = Buffer.byteLength(payload);
        }
        const req = http.request({ host: '127.0.0.1', port, method, path: url, headers: h }, res => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                let json = null;
                try { json = JSON.parse(text); } catch (e) { /* html */ }
                resolve({ status: res.statusCode, headers: res.headers, text, json });
            });
        });
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}
const page = (url, headers = {}, host = OLD) => request('GET', url, { host, headers: { 'Sec-Fetch-Dest': 'document', Accept: 'text/html', ...headers } });
const isMovingPage = r => r.status === 200 && /moved to/.test(r.text) && /\/api\/auth\/move/.test(r.text);
const startMove = (storage, { cookie = '', origin = OLD_ORIGIN, host = OLD, ip, ua = UA } = {}) => request('POST', '/api/auth/move', {
    host, ip, body: { storage }, headers: { Origin: origin, 'Sec-Fetch-Site': 'same-origin', 'User-Agent': ua, ...(cookie ? { Cookie: cookie } : {}) },
});
const claim = (code, { cookie = '', origin = NEW_ORIGIN, host = NEW, ip, ua = UA } = {}) => request('POST', '/api/auth/move/claim', {
    host, ip, body: { code }, headers: { Origin: origin, 'Sec-Fetch-Site': 'same-origin', 'User-Agent': ua, ...(cookie ? { Cookie: cookie } : {}) },
});
const setCookies = r => [].concat(r.headers['set-cookie'] || []);
const errCode = r => r.json && r.json.error && r.json.error.code;

// ---- a tiny browser for the page scripts ----
function fakeStorage(init = {}) {
    const data = Object.assign(Object.create(null), init);
    return {
        data,
        getItem: k => (k in data ? data[k] : null),
        setItem: (k, v) => { data[k] = String(v); },
        removeItem: k => { delete data[k]; },
        key: i => Object.keys(data)[i] ?? null,
        get length() { return Object.keys(data).length; },
    };
}

// Runs `code` as a page on host at url. fetch goes to this test server with
// the page's Host and Origin; the cookie jar is a plain string.
function runPage(code, { host, url, storage, cookie = '', hangFetch = false, failFetch = false }) {
    const u = new URL('http://' + host + url);
    const out = { replaced: null, reloaded: 0, stopped: 0, fetches: [], timers: [], replaceState: null, cookie };
    let done;
    out.finished = new Promise(r => { done = r; });
    const location = {
        hostname: u.hostname, host: u.host, pathname: u.pathname, search: u.search, hash: u.hash, origin: u.origin,
        replace: to => { out.replaced = to; done(); },
        reload: () => { out.reloaded++; done(); },
    };
    const win = {
        localStorage: storage, sessionStorage: fakeStorage(), location, document: { referrer: '', documentElement: { className: '', style: {} } },
        history: { replaceState: (s, t, to) => { out.replaceState = to; const n = new URL(to, u); location.pathname = n.pathname; location.search = n.search; location.hash = n.hash; } },
        setTimeout: (fn, ms) => { out.timers.push({ fn, ms }); return out.timers.length; },
        stop: () => { out.stopped++; },
        JSON, Object, encodeURIComponent, decodeURIComponent, URL,
        fetch: async (path, opts) => {
            out.fetches.push({ path, body: JSON.parse(opts.body) });
            if (failFetch) throw new TypeError('network');
            if (hangFetch) return new Promise(() => {});
            const r = await request(opts.method, path, {
                host, body: opts.body,
                headers: { Origin: 'http://' + host, 'Sec-Fetch-Site': 'same-origin', ...(out.cookie ? { Cookie: out.cookie } : {}) },
            });
            for (const c of setCookies(r)) {
                const [pair] = c.split(';');
                out.cookie = (out.cookie ? out.cookie + '; ' : '') + pair;
            }
            return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.json };
        },
    };
    win.window = win;
    win.top = win;
    win.self = win;
    win.document.documentElement = win.document.documentElement;
    vm.runInNewContext(code, win);
    return out;
}
const scriptOf = html => /<script(?: nonce="[^"]*")?>([\s\S]*?)<\/script>/.exec(html)[1];
const INDEX = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'index.html'), 'utf8');
const CLAIM_SCRIPT = scriptOf(INDEX);
const settle = (p, ms = 3000) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error('page did not navigate')), ms))]);

// ===================================================================

test('config: MOVE_FROM_HOST adds the www twin and keeps the old origins allowed', () => {
    assert.deepEqual([...config.moveHosts], [OLD, 'www.' + OLD]);
    assert.ok(config.moveOrigins.has(OLD_ORIGIN) && config.moveOrigins.has('http://www.' + OLD));
    assert.ok(config.isAllowedOrigin(OLD_ORIGIN) && config.isAllowedOrigin(NEW_ORIGIN));
    assert.ok(config.isMoveHost('OLD.test') && config.isMoveHost('old.test.') && config.isMoveHost('www.old.test'));
    assert.ok(!config.isMoveHost(NEW) && !config.isMoveHost('') && !config.isMoveHost('evil.old.test'));
    assert.equal(config.discordRedirectFor(OLD), OLD_ORIGIN + '/auth/discord/callback');
    assert.equal(config.discordRedirectFor(NEW), NEW_ORIGIN + '/auth/discord/callback');
});

test('page: only page loads on the old host get the moving page', async () => {
    let r = await page('/');
    assert.ok(isMovingPage(r), r.text.slice(0, 200));
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.match(r.headers['content-security-policy'], /frame-ancestors \*/);
    assert.equal(r.headers['x-frame-options'], undefined);
    assert.ok(r.text.includes(`url=${NEW_ORIGIN}/"`), 'noscript refresh');
    // portals frame us, and older browsers send no Sec-Fetch-Dest
    assert.ok(isMovingPage(await page('/', { 'Sec-Fetch-Dest': 'iframe' })));
    assert.ok(isMovingPage(await request('GET', '/about', { headers: { Accept: 'text/html,application/xhtml+xml' } })));
    assert.ok(isMovingPage(await page('/www', {}, 'www.' + OLD)));
    r = await page('/?utm_source=x&a=<b>');
    assert.ok(r.text.includes(`url=${NEW_ORIGIN}/?utm_source=x&amp;a=&lt;b&gt;"`), 'query escaped');
    // HEAD: headers only
    r = await request('HEAD', '/', { headers: { 'Sec-Fetch-Dest': 'document' } });
    assert.equal(r.status, 200);
    assert.equal(r.text, '');
});

test('page: API, assets, sockets and the new host are left alone', async () => {
    const notMoving = async (r, what) => assert.ok(!isMovingPage(r), what);
    await notMoving(await page('/client/app.js'), 'script by navigation');
    await notMoving(await page('/img/og.png'), 'image');
    await notMoving(await page('/', { 'Sec-Fetch-Dest': 'script' }), 'subresource');
    await notMoving(await page('/', { 'Sec-Fetch-Dest': 'websocket' }), 'websocket handshake');
    await notMoving(await page('/', { 'Sec-Fetch-Dest': 'empty' }), 'fetch');
    await notMoving(await request('GET', '/getServers.json', { headers: { Accept: '*/*' } }), 'servers list');
    await notMoving(await request('POST', '/', { body: {} }), 'POST');
    await notMoving(await page('/', {}, NEW), 'new host');
    await notMoving(await page('/auth/discord/callback?code=x&state=y'), 'OAuth callback');
    let r = await page('/api/me');
    assert.equal(r.status, 200);
    assert.equal(r.json.user, null);
    r = await request('GET', '/api/config', { headers: { 'Sec-Fetch-Dest': 'empty' } });
    assert.equal(r.status, 200);
    assert.equal(typeof r.json.accounts, 'boolean');
    // the static fallback in this harness answers everything else
    assert.equal((await page('/client/app.js')).text, 'static');
});

test('page: a Discord login started on the old host comes back to the old host', async () => {
    const r = await request('GET', '/auth/discord/start?mode=login', { headers: { 'Sec-Fetch-Dest': 'document' } });
    assert.equal(r.status, 302);
    const to = new URL(r.headers.location);
    assert.equal(to.searchParams.get('redirect_uri'), OLD_ORIGIN + '/auth/discord/callback');
    assert.ok(setCookies(r).some(c => c.startsWith('dw_oauth=')));
    const r2 = await request('GET', '/auth/discord/start?mode=login', { host: NEW });
    assert.equal(new URL(r2.headers.location).searchParams.get('redirect_uri'), NEW_ORIGIN + '/auth/discord/callback');
});

test('handoff: storage and login cookies move over once', async () => {
    const user = mkUser();
    const token = tokenFor(user);
    const dev = devValue(user);
    let r = await startMove({ dwGuestId: 'g'.repeat(32), keybinds: '{"w":1}', dwMoved: 'x', bad: 5 }, { cookie: `dw_sid=${token}; dw_dev=${dev}` });
    assert.equal(r.status, 200, r.text);
    const code = r.json.code;
    assert.match(code, /^[A-Za-z0-9_-]{32}$/);
    r = await claim(code);
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.storage, { dwGuestId: 'g'.repeat(32), keybinds: '{"w":1}' });
    assert.equal(r.json.cookies, 2);
    const sc = setCookies(r);
    const sid = sc.find(c => c.startsWith('dw_sid='));
    assert.ok(sid && sid.includes(token) && /HttpOnly/.test(sid) && /SameSite=Lax/.test(sid) && /Path=\//.test(sid), sid);
    assert.ok(sc.some(c => c.startsWith('dw_dev=') && /Path=\/api\/auth/.test(c)));
    // the cookie works on the new host
    r = await request('GET', '/api/me', { host: NEW, headers: { Cookie: 'dw_sid=' + token } });
    assert.ok(r.json.user, 'logged in on the new host');
    // one time only
    r = await claim(code);
    assert.equal(r.status, 404);
    assert.equal(errCode(r), 'not_found');
});

test('handoff: a guest with storage and no cookie, and made-up codes', async () => {
    let r = await startMove({ a: '1' });
    r = await claim(r.json.code);
    assert.deepEqual(r.json.storage, { a: '1' });
    assert.equal(r.json.cookies, 0);
    assert.equal(setCookies(r).length, 0);
    for (const bad of ['', 'x'.repeat(32), 'short', null, 42, '../../etc']) {
        r = await claim(bad);
        assert.equal(r.status, 404, String(bad));
    }
});

test('handoff: cookies already on the new host win, dead sessions are not copied', async () => {
    const a = mkUser(), b = mkUser();
    const ta = tokenFor(a), tb = tokenFor(b);
    let r = await startMove({}, { cookie: 'dw_sid=' + ta });
    r = await claim(r.json.code, { cookie: 'dw_sid=' + tb });
    assert.equal(r.json.cookies, 0);
    assert.ok(!setCookies(r).some(c => c.startsWith('dw_sid=')));
    // a stale cookie on the new host is replaced
    r = await startMove({}, { cookie: 'dw_sid=' + ta });
    r = await claim(r.json.code, { cookie: 'dw_sid=' + 'z'.repeat(43) });
    assert.ok(setCookies(r).some(c => c.startsWith('dw_sid=' + ta)));
    // a revoked session on the old host is not carried
    const tc = tokenFor(a);
    r = await startMove({ k: 'v' }, { cookie: 'dw_sid=' + tc });
    accounts.sessions.revokeByToken(tc);
    r = await claim(r.json.code);
    assert.equal(r.json.cookies, 0);
    assert.deepEqual(r.json.storage, { k: 'v' });
});

test('handoff: hosts, origins and the browser are checked', async () => {
    let r = await startMove({ a: '1' }, { origin: NEW_ORIGIN });
    assert.equal(r.status, 403);
    r = await startMove({ a: '1' }, { host: NEW, origin: NEW_ORIGIN });
    assert.equal(r.status, 403, 'no handoffs from the new host');
    r = await startMove({ a: '1' }, { origin: 'https://evil.example' });
    assert.equal(r.status, 403);
    r = await request('POST', '/api/auth/move', { body: { storage: {} }, headers: { Origin: OLD_ORIGIN, 'Sec-Fetch-Site': 'cross-site' } });
    assert.equal(r.status, 403);
    r = await request('POST', '/api/auth/move', { body: 'storage=1', headers: { Origin: OLD_ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded' } });
    assert.equal(r.status, 415);
    r = await startMove({ a: '1' });
    const code = r.json.code;
    assert.equal((await claim(code, { origin: OLD_ORIGIN })).status, 403);
    assert.equal((await claim(code, { host: OLD, origin: OLD_ORIGIN })).status, 403);
    // another browser holding the link gets nothing, and the code is spent
    assert.equal((await claim(code, { ua: 'curl/8' })).status, 404);
    assert.equal((await claim(code)).status, 404);
});

test('handoff: size caps', async () => {
    let r = await startMove({ big: 'x'.repeat(move.MAX_CHARS) });
    assert.equal(r.status, 413);
    r = await startMove({ big: 'x'.repeat(700 * 1024) });
    assert.equal(r.status, 413);
    r = await startMove({ big: 'x'.repeat(move.MAX_CHARS - 10) });
    assert.equal(r.status, 200);
    assert.equal((await claim(r.json.code)).json.storage.big.length, move.MAX_CHARS - 10);
    const many = {};
    for (let i = 0; i < 2001; i++) many['k' + i] = '1';
    assert.equal(move.cleanStorage(many), false);
    assert.equal(move.cleanStorage([1]), null);
    assert.equal(move.cleanStorage('x'), null);
    const odd = move.cleanStorage(JSON.parse('{"__proto__":"p","n":1,"ok":"y"}'));
    assert.equal(odd.storage.__proto__, 'p');
    assert.equal(odd.storage.n, undefined);
    assert.deepEqual(Object.keys(odd.storage), ['__proto__', 'ok']);
});

test('handoff: codes expire after two minutes', () => {
    const t = Date.now() + 10 * 60 * 1000;
    const code = move.put({ ua: '', storage: {}, chars: 0 }, t);
    const later = move.put({ ua: '', storage: {}, chars: 0 }, t);
    assert.ok(move.take(code, t + move.CODE_TTL_MS - 1));
    assert.equal(move.take(later, t + move.CODE_TTL_MS + 1), null);
});

test('handoff: rate limited per IP', async () => {
    const ip = freshIp();
    let last = null;
    for (let i = 0; i < 61; i++) last = await startMove({}, { ip });
    assert.equal(last.status, 429);
    const ip2 = freshIp();
    for (let i = 0; i < 61; i++) last = await claim('y'.repeat(32), { ip: ip2 });
    assert.equal(last.status, 429);
});

// ---- the page scripts, end to end ----

async function movingPageScript(url, cookie = '') {
    const r = await page(url, cookie ? { Cookie: cookie } : {});
    assert.ok(isMovingPage(r));
    return scriptOf(r.text);
}

test('client: old host -> new host carries storage and the session, then a plain redirect next time', async () => {
    const user = mkUser();
    const token = tokenFor(user);
    const oldLs = fakeStorage({ dwGuestId: 'a'.repeat(32), optColors: 'dark', coachDone: '1' });
    const js = await movingPageScript('/?utm_source=portal#tut', 'dw_sid=' + token);
    let p = runPage(js, { host: OLD, url: '/?utm_source=portal#tut', storage: oldLs, cookie: 'dw_sid=' + token });
    await settle(p.finished);
    assert.equal(p.fetches.length, 1);
    assert.equal(oldLs.getItem('dwMoved'), '1');
    const to = new URL(p.replaced);
    assert.equal(to.origin, NEW_ORIGIN);
    assert.equal(to.pathname + to.search, '/?utm_source=portal');
    const m = /^#move=([\w-]+)&tut$/.exec(to.hash);
    assert.ok(m, to.hash);

    // the new host already has one setting of its own
    const newLs = fakeStorage({ optColors: 'light' });
    p = runPage(CLAIM_SCRIPT, { host: NEW, url: to.pathname + to.search + to.hash, storage: newLs });
    await settle(p.finished);
    assert.equal(p.stopped, 1, 'the rest of the page is stopped');
    assert.equal(p.reloaded, 1);
    assert.equal(p.replaceState, '/?utm_source=portal#tut');
    assert.equal(newLs.getItem('dwGuestId'), 'a'.repeat(32));
    assert.equal(newLs.getItem('coachDone'), '1');
    assert.equal(newLs.getItem('optColors'), 'light', 'kept the existing key');
    assert.equal(newLs.getItem('dwMoved'), null);
    assert.ok(p.cookie.includes('dw_sid=' + token), 'session cookie set on the new host');

    // the reload: no code in the hash, so the page just runs (dwSrc is set)
    const again = runPage(CLAIM_SCRIPT, { host: NEW, url: '/?utm_source=portal#tut', storage: newLs });
    assert.equal(again.fetches.length + again.stopped + again.reloaded, 0);
    assert.equal(newLs.getItem('dwSrc'), 'portal');

    // and the old host now redirects straight away
    p = runPage(await movingPageScript('/devlog'), { host: OLD, url: '/devlog', storage: oldLs });
    assert.equal(p.fetches.length, 0);
    assert.equal(p.replaced, NEW_ORIGIN + '/devlog');
});

test('client: a new visitor with nothing to move just goes', async () => {
    const p = runPage(await movingPageScript('/'), { host: OLD, url: '/', storage: fakeStorage() });
    assert.equal(p.fetches.length, 0);
    assert.equal(p.replaced, NEW_ORIGIN + '/');
});

test('client: signed in with empty storage still hands over the cookie', async () => {
    const user = mkUser();
    const token = tokenFor(user);
    const p = runPage(await movingPageScript('/', 'dw_sid=' + token), { host: OLD, url: '/', storage: fakeStorage(), cookie: 'dw_sid=' + token });
    await settle(p.finished);
    assert.equal(p.fetches.length, 1);
    assert.match(p.replaced, /#move=[\w-]+$/);
});

test('client: other pages go through the menu and come back', async () => {
    const oldLs = fakeStorage({ x: '1' });
    let p = runPage(await movingPageScript('/about?a=1'), { host: OLD, url: '/about?a=1#top', storage: oldLs });
    await settle(p.finished);
    const to = new URL(p.replaced);
    assert.equal(to.pathname, '/');
    assert.match(to.hash, /^#move=[\w-]+&movenext=%2Fabout%3Fa%3D1%23top$/);
    const newLs = fakeStorage();
    p = runPage(CLAIM_SCRIPT, { host: NEW, url: '/' + to.hash, storage: newLs });
    await settle(p.finished);
    assert.equal(p.replaced, '/about?a=1#top');
    assert.equal(p.reloaded, 0);
    assert.equal(newLs.getItem('x'), '1');
    // a movenext pointing off site is ignored
    p = runPage(CLAIM_SCRIPT, { host: NEW, url: '/#move=' + 'q'.repeat(32) + '&movenext=%2F%2Fevil.example', storage: fakeStorage() });
    await settle(p.finished);
    assert.equal(p.replaced, null);
    assert.equal(p.reloaded, 1);
});

test('client: a failed or slow handoff still redirects, and tries again next visit', async () => {
    let oldLs = fakeStorage({ x: '1' });
    let p = runPage(await movingPageScript('/'), { host: OLD, url: '/', storage: oldLs, failFetch: true });
    await settle(p.finished);
    assert.equal(p.replaced, NEW_ORIGIN + '/');
    assert.equal(oldLs.getItem('dwMoved'), null);
    p = runPage(await movingPageScript('/'), { host: OLD, url: '/', storage: oldLs, hangFetch: true });
    assert.equal(p.replaced, null);
    const t = p.timers.find(x => x.ms === 2500);
    assert.ok(t, 'a 2.5 s fallback');
    t.fn();
    assert.equal(p.replaced, NEW_ORIGIN + '/');
    // an expired code: the claim strips it and reloads once, nothing else
    const newLs = fakeStorage();
    p = runPage(CLAIM_SCRIPT, { host: NEW, url: '/#move=' + 'n'.repeat(32), storage: newLs });
    await settle(p.finished);
    assert.equal(p.reloaded, 1);
    assert.equal(p.replaceState, '/');
    assert.equal(newLs.length, 0);
    // and a claim that hangs gives up after 4 s the same way
    p = runPage(CLAIM_SCRIPT, { host: NEW, url: '/#move=' + 'h'.repeat(32), storage: fakeStorage(), hangFetch: true });
    p.timers.find(x => x.ms === 4000).fn();
    assert.equal(p.reloaded, 1);
});

test('text: the site points at corez.io, no em dashes in the new code', () => {
    const EM_DASH = String.fromCharCode(0x2014);
    const PUB = path.join(__dirname, '..', '..', 'public');
    for (const f of ['index.html', 'about.html', 'devlog.html']) {
        const html = fs.readFileSync(path.join(PUB, f), 'utf8');
        assert.ok(!html.includes('corez.games'), f);
        assert.match(html, /<link rel="canonical" href="https:\/\/corez\.io\//, f);
    }
    for (const f of ['client/raidShare.js', 'client/account/welcome.js']) assert.ok(!fs.readFileSync(path.join(PUB, f), 'utf8').includes('corez.games'), f);
    for (const f of [path.join(__dirname, '..', '..', 'server', 'accounts', 'routes', 'move.js'), __filename]) {
        assert.ok(!fs.readFileSync(f, 'utf8').includes(EM_DASH), path.basename(f) + ' has no em dash');
    }
    assert.ok(!CLAIM_SCRIPT.includes(EM_DASH));
});

// ===================================================================

async function main() {
    const quietLog = console.log, quietWarn = console.warn;
    console.log = (...args) => { if (!/^\[(accounts|backup|discord|clientIp|party)\]/.test(String(args[0]))) quietLog(...args); };
    console.warn = (...args) => { if (!/^\[(accounts|backup|discord|clientIp|party)\]/.test(String(args[0]))) quietWarn(...args); };
    assert.equal(accounts.initMain(), true, 'initMain');
    // server.js's order: the moving page, then accounts, then static files
    const server = http.createServer((req, res) => {
        if (accounts.move.servePage(req, res)) return;
        if (accounts.handleHttp(req, res)) return;
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('static');
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    port = server.address().port;
    let failed = 0;
    const t0 = Date.now();
    for (const t of tests) {
        const started = Date.now();
        try {
            await t.fn();
            quietLog(`ok   ${t.name} (${Date.now() - started} ms)`);
        } catch (e) {
            failed++;
            quietLog(`FAIL ${t.name}\n     ${((e && e.stack) || e).toString().split('\n').slice(0, 8).join('\n     ')}`);
        }
    }
    server.close();
    accounts.shutdown();
    quietLog(`\n${tests.length - failed}/${tests.length} passed in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    if (!failed) fs.rmSync(ROOT, { recursive: true, force: true });
    else quietLog('test data kept in ' + ROOT);
    process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
