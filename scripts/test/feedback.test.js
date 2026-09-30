// Menu feedback: node scripts/test/feedback.test.js
//
//   route      POST /api/feedback validation (origin, JSON, text length,
//              category, junk context), guests and accounts
//   storage    what lands in the feedback table (no IP, cleaned context,
//              a logged-in user never stored as a guest)
//   limits     3 per 10 minutes per IP and per guest / account; rejected
//              messages cost nothing
//   discord    each message is posted to the feedback channel (the backup
//              channel by default); a missing channel fails quietly and is
//              left alone after that
//   command    /feedback [count] lists the latest, admin only (audited)
//   migration  v7 -> v8 keeps every row, writes the backup, adds feedback
//
// Data goes under $DATA_DIR if set, otherwise the OS temp dir; it is removed
// when everything passes.
'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const nodeCrypto = require('crypto');

const ROOT = process.env.DATA_DIR
    ? path.join(process.env.DATA_DIR, `feedback-test-${process.pid}-${Date.now()}`)
    : fs.mkdtempSync(path.join(os.tmpdir(), 'dw-feedback-test-'));
const DATA_DIR = path.join(ROOT, 'data');

const { publicKey, privateKey } = nodeCrypto.generateKeyPairSync('ed25519');
const PUB_HEX = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
const APP = '111111111111111111', GUILD = '222222222222222222', ADMIN = '333333333333333333', OTHER = '444444444444444444';
const BACKUP_CH = '555555555555555555';

process.env.DATA_DIR = DATA_DIR;
for (const k of ['DB_PATH', 'PUBLIC_HOST', 'PUBLIC_ORIGIN', 'ALLOWED_ORIGINS', 'ROYALE_DEBUG', 'ACCOUNTS_ALLOW_DEBUG', 'DISCORD_BOT_TOKEN',
    'DISCORD_ANNOUNCE_CHANNEL_ID', 'DISCORD_BACKUP_CHANNEL_ID', 'DISCORD_FEEDBACK_CHANNEL_ID', 'BACKUP_ENCRYPTION_KEY', 'TRUSTED_PROXIES']) delete process.env[k];
Object.assign(process.env, {
    NODE_ENV: 'test', ACCOUNTS_ENABLED: 'true', SESSION_SECRET: 'feedback-test-secret-0123456789-abcdefghij',
    DISCORD_APP_ID: APP, DISCORD_PUBLIC_KEY: PUB_HEX, DISCORD_ADMIN_GUILD_ID: GUILD, ADMIN_DISCORD_IDS: ADMIN, PORT: '3000',
    DISCORD_BOT_TOKEN: 'test-bot-token', DISCORD_BACKUP_CHANNEL_ID: BACKUP_CH,
});

const accounts = require('../../server/accounts');
const feedback = require('../../server/accounts/feedback');
const rest = require('../../server/accounts/discord/rest');
const commands = require('../../server/accounts/discord/commands');
const migrations = require('../../server/accounts/migrations');
const dbmod = require('../../server/accounts/db');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
const D = () => accounts.db.handle();
let seq = 0;
function mkUser(prefix = 'fb') {
    const r = accounts.users.create({ username: (prefix + '_' + (++seq) + '_' + Math.floor(Math.random() * 1e4)).slice(0, 16), recoveryHash: null });
    assert.ok(r.ok, JSON.stringify(r));
    return r.user;
}
const hex32 = c => c.repeat(32);

// ---- a fake Discord ----
let discordCalls = [];
let discordReply = () => ({ status: 200, body: { id: '1' } });
rest.setFetchForTests(async (url, opts) => {
    discordCalls.push({ url, body: opts.body ? JSON.parse(opts.body) : null });
    const r = discordReply(url);
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'Content-Type': 'application/json' } });
});
const settle = () => new Promise(r => setTimeout(r, 30));

// ---- HTTP ----
let base = '';
let ipSeq = 0;
const freshIp = () => `10.9.${Math.floor(++ipSeq / 250)}.${(ipSeq % 250) + 1}`;
async function send(body, { ip = freshIp(), cookie = '', origin = base, type = 'application/json', raw = null } = {}) {
    const headers = { 'Content-Type': type, 'X-Forwarded-For': ip };
    if (origin) headers.Origin = origin;
    if (cookie) headers.Cookie = cookie;
    const r = await fetch(base + '/api/feedback', { method: 'POST', headers, body: raw != null ? raw : JSON.stringify(body) });
    let json = null;
    try { json = await r.json(); } catch (e) { json = null; }
    return { status: r.status, json };
}
const code = r => r.json && r.json.error && r.json.error.code;
const cookieFor = user => 'dw_sid=' + accounts.sessions.create(user.id, { method: 'password' }).token;
const row = id => D().get('SELECT * FROM feedback WHERE id = ?', id);

function sign(body, ts = String(Math.floor(Date.now() / 1000))) {
    return { ts, sig: nodeCrypto.sign(null, Buffer.from(ts + body), privateKey).toString('hex') };
}
async function interact(obj) {
    const body = JSON.stringify(obj);
    const s = sign(body);
    const r = await fetch(base + '/discord/interactions', {
        method: 'POST', body,
        headers: { 'Content-Type': 'application/json', 'X-Signature-Ed25519': s.sig, 'X-Signature-Timestamp': s.ts },
    });
    return { status: r.status, json: await r.json() };
}
function cmd(name, options = [], who = ADMIN, guild = GUILD) {
    return { type: 2, application_id: APP, guild_id: guild || undefined, member: { user: { id: who, username: 'tester' } }, data: { name, options } };
}

// ===================================================================

test('route: rejects bad requests before storing or charging anything', async () => {
    const before = feedback.count();
    const ip = freshIp();
    let r = await send({ text: 'hello there' }, { ip, origin: '' });
    assert.equal(r.status, 403);
    r = await send({ text: 'hello there' }, { ip, origin: 'https://evil.example' });
    assert.equal(r.status, 403);
    r = await send(null, { ip, type: 'text/plain', raw: 'text=hi' });
    assert.equal(r.status, 415);
    r = await send({}, { ip });
    assert.equal(code(r), 'too_short');
    r = await send({ text: '   \n\n  ' }, { ip });
    assert.equal(code(r), 'too_short');
    r = await send({ text: 'ok' }, { ip });
    assert.equal(code(r), 'too_short');
    r = await send({ text: 42 }, { ip });
    assert.equal(code(r), 'bad_text');
    r = await send({ text: 'x'.repeat(1001) }, { ip });
    assert.equal(r.status, 400);
    assert.equal(code(r), 'too_long');
    r = await send({ text: 'a real message', category: 'rant' }, { ip });
    assert.equal(code(r), 'bad_category');
    r = await send({ text: 'a real message', category: ['bug'] }, { ip });
    assert.equal(code(r), 'bad_category');
    assert.equal(feedback.count(), before, 'nothing stored');
    // none of those used up the IP's budget
    for (let k = 0; k < 3; k++) assert.equal((await send({ text: 'fine message ' + k }, { ip })).status, 201);
});

test('storage: a guest message, cleaned text and context, no IP column', async () => {
    const g = hex32('a');
    const r = await send({
        text: '  Storm\r\nkilled me\u0007 through a wall\n\n\n\n\nhelp  ',
        category: 'bug', guestId: g,
        context: {
            version: '1.4.2', browser: 'Chrome 131 on macOS', screen: '1440x900@2x', region: 'US East',
            server: 'corez.games', embed: 'iogames.space', inGame: true,
            evil: 'x'.repeat(5000), cookie: 'dw_sid=abc',
        },
    });
    assert.equal(r.status, 201);
    assert.equal(r.json.ok, true);
    const f = row(r.json.id);
    assert.equal(f.user_id, null);
    assert.equal(f.guest_id, g);
    assert.equal(f.category, 'bug');
    assert.equal(f.text, 'Storm\nkilled me through a wall\n\n\nhelp');
    assert.deepEqual(JSON.parse(f.context), {
        version: '1.4.2', browser: 'Chrome 131 on macOS', screen: '1440x900@2x', region: 'US East',
        server: 'corez.games', embed: 'iogames.space', inGame: true,
    });
    const cols = D().all('PRAGMA table_info(feedback)').map(c => c.name);
    assert.deepEqual(cols, ['id', 'at', 'user_id', 'guest_id', 'category', 'text', 'context']);
    assert.ok(Math.abs(f.at - Date.now()) < 5000);
});

test('storage: no category, no context, bad guest id and bad context values dropped', async () => {
    let r = await send({ text: 'just saying hi', guestId: 'not-a-guest' });
    assert.equal(r.status, 201);
    let f = row(r.json.id);
    assert.equal(f.category, null);
    assert.equal(f.guest_id, null);
    assert.equal(f.context, '{}');
    r = await send({ text: 'weird context', category: '', context: { screen: '<script>', embed: 'https://x.y/z', version: 7, inGame: 'yes' } });
    f = row(r.json.id);
    assert.equal(f.category, null);
    assert.equal(f.context, '{}');
    r = await send({ text: 'array context', context: ['a'] });
    assert.equal(row(r.json.id).context, '{}');
    // exactly 1000 characters is fine
    r = await send({ text: 'y'.repeat(1000) });
    assert.equal(r.status, 201);
    assert.equal(row(r.json.id).text.length, 1000);
});

test('storage: a logged-in player is stored by account, never as a guest', async () => {
    const u = mkUser();
    const r = await send({ text: 'love the new shop', category: 'idea', guestId: hex32('b') }, { cookie: cookieFor(u) });
    assert.equal(r.status, 201);
    const f = row(r.json.id);
    assert.equal(f.user_id, u.id);
    assert.equal(f.guest_id, null);
    const [latest] = feedback.latest(1);
    assert.equal(latest.id, r.json.id);
    assert.equal(latest.username, u.username);
    assert.deepEqual(latest.context, {});
});

test('limits: 3 per 10 minutes per IP', async () => {
    const ip = freshIp();
    for (let k = 0; k < 3; k++) assert.equal((await send({ text: 'message ' + k }, { ip })).status, 201);
    const r = await send({ text: 'one too many' }, { ip });
    assert.equal(r.status, 429);
    assert.equal(code(r), 'rate_limited');
    assert.ok(r.json.error.retryAfter > 0 && r.json.error.retryAfter <= 600);
    // another address is fine
    assert.equal((await send({ text: 'someone else' })).status, 201);
});

test('limits: per guest id and per account across addresses', async () => {
    const g = hex32('c');
    for (let k = 0; k < 3; k++) assert.equal((await send({ text: 'guest msg ' + k, guestId: g })).status, 201);
    assert.equal((await send({ text: 'new ip same guest', guestId: g })).status, 429);
    assert.equal((await send({ text: 'new ip other guest', guestId: hex32('d') })).status, 201);
    const u = mkUser();
    const c = cookieFor(u);
    for (let k = 0; k < 3; k++) assert.equal((await send({ text: 'acct msg ' + k }, { cookie: c })).status, 201);
    assert.equal((await send({ text: 'acct again' }, { cookie: c })).status, 429);
    assert.equal(accounts.ratelimit.WINDOWS.feedback.limit, 3);
    assert.equal(accounts.ratelimit.WINDOWS.feedback.windowMs, 10 * 60 * 1000);
});

test('discord: each message goes to the backup channel as an embed, no mentions', async () => {
    feedback.resetForward();
    discordCalls = [];
    discordReply = () => ({ status: 200, body: { id: '9' } });
    const u = mkUser('zz');
    const r = await send({ text: 'hey @everyone the *storm* is <@123> too fast', category: 'balance', context: { version: '2.0.0', region: 'Europe' } }, { cookie: cookieFor(u) });
    assert.equal(r.status, 201);
    await settle();
    assert.equal(discordCalls.length, 1);
    const call = discordCalls[0];
    assert.ok(call.url.endsWith(`/channels/${BACKUP_CH}/messages`), call.url);
    assert.deepEqual(call.body.allowed_mentions, { parse: [] });
    const e = call.body.embeds[0];
    assert.equal(e.title, 'Feedback: Balance');
    assert.match(e.description, /\\\*storm\\\*/);
    assert.match(e.description, /\\@everyone/);
    assert.equal(e.fields[0].name, 'From');
    assert.equal(e.fields[0].value, rest.escapeMd(u.username));
    assert.equal(e.fields[1].value, "v2.0.0 · Europe");
    assert.match(e.footer.text, new RegExp('#' + r.json.id));
    // a guest shows by the start of their id
    discordCalls = [];
    await send({ text: 'guest here', guestId: hex32('e') });
    await settle();
    assert.equal(discordCalls[0].body.embeds[0].fields[0].value, 'guest eeeeee');
    assert.equal(discordCalls[0].body.embeds[0].title, 'Feedback: No category');
});

test('discord: an unknown channel fails quietly, the message is still saved, then no more tries for a while', async () => {
    feedback.resetForward();
    discordCalls = [];
    discordReply = () => ({ status: 404, body: { message: 'Unknown Channel', code: 10003 } });
    const errs = [];
    const origErr = console.error;
    console.error = (...a) => errs.push(a.join(' '));
    try {
        const r1 = await send({ text: 'first after the channel broke' });
        assert.equal(r1.status, 201);
        await settle();
        const r2 = await send({ text: 'second after the channel broke' });
        assert.equal(r2.status, 201);
        await settle();
        assert.ok(row(r1.json.id) && row(r2.json.id));
    } finally {
        console.error = origErr;
    }
    assert.equal(discordCalls.length, 1, 'parked after the 404');
    assert.equal(errs.filter(e => /feedback post failed/.test(e)).length, 1);
    // a separate feedback channel wins over the backup one
    feedback.resetForward();
    discordCalls = [];
    discordReply = () => ({ status: 200, body: { id: '1' } });
    const bot = accounts.config.discordBot;
    const was = bot.feedbackChannelId;
    bot.feedbackChannelId = '666666666666666666';
    try {
        await send({ text: 'to the feedback channel' });
        await settle();
        assert.ok(discordCalls[0].url.includes('/channels/666666666666666666/'));
    } finally { bot.feedbackChannelId = was; }
    // no bot token: nothing is sent, nothing breaks
    const tok = bot.botToken;
    bot.botToken = '';
    discordCalls = [];
    try {
        assert.equal((await send({ text: 'no bot configured' })).status, 201);
        await settle();
        assert.equal(discordCalls.length, 0);
    } finally { bot.botToken = tok; }
});

test('config: DISCORD_FEEDBACK_CHANNEL_ID falls back to the backup channel', () => {
    assert.equal(accounts.config.discordBot.feedbackChannelId, BACKUP_CH);
    process.env.DISCORD_FEEDBACK_CHANNEL_ID = '777777777777777777';
    accounts.config.load();
    try { assert.equal(accounts.config.discordBot.feedbackChannelId, '777777777777777777'); } finally {
        delete process.env.DISCORD_FEEDBACK_CHANNEL_ID;
        accounts.config.load();
    }
    assert.equal(accounts.config.discordBot.feedbackChannelId, BACKUP_CH);
});

test('command: /feedback is an admin command with an optional count', () => {
    const def = commands.ADMIN_COMMANDS.find(c => c.name === 'feedback');
    assert.ok(def, 'registered with the admin commands');
    assert.ok(commands.ADMIN_NAMES.has('feedback'));
    assert.ok(!commands.PLAYER_COMMANDS.some(c => c.name === 'feedback'));
    assert.deepEqual(def.options.map(o => [o.name, o.type, o.required, o.min_value, o.max_value]), [['count', 4, false, 1, 25]]);
});

test('command: /feedback lists the latest, newest first, trimmed; count works', async () => {
    const u = mkUser('lst');
    D().run('DELETE FROM feedback');
    for (let k = 1; k <= 12; k++) {
        feedback.add({ userId: k % 2 ? u.id : null, guestId: k % 2 ? null : hex32('f'), category: k % 3 ? 'idea' : null, text: `note ${k} ` + (k === 12 ? 'z'.repeat(900) : '') }, Date.now() - (12 - k) * 1000);
    }
    let r = await interact(cmd('feedback'));
    assert.equal(r.json.data.flags, 64, 'ephemeral');
    let emb = r.json.data.embeds[0];
    assert.equal(emb.title, 'Feedback (12)');
    const ids = [...emb.description.matchAll(/\*\*#(\d+)\*\*/g)].map(m => +m[1]);
    assert.equal(ids.length, 10, 'default 10');
    assert.deepEqual(ids, ids.slice().sort((a, b) => b - a), 'newest first');
    assert.match(emb.description, /note 12 z+…/);
    assert.ok(!emb.description.includes('z'.repeat(500)), 'long text trimmed');
    assert.match(emb.description, new RegExp(rest.escapeMd(u.username).replace(/\\/g, '\\\\')));
    assert.match(emb.description, /guest ffffff/);
    assert.match(emb.description, /No category/);
    assert.match(emb.description, /<t:\d+:R>/);
    assert.ok(emb.description.length <= 4000);
    r = await interact(cmd('feedback', [{ name: 'count', type: 4, value: 3 }]));
    emb = r.json.data.embeds[0];
    assert.equal([...emb.description.matchAll(/\*\*#(\d+)\*\*/g)].length, 3);
    r = await interact(cmd('feedback', [{ name: 'count', type: 4, value: 25 }]));
    assert.equal([...r.json.data.embeds[0].description.matchAll(/\*\*#(\d+)\*\*/g)].length, 12);
    const a = D().all("SELECT actor, detail FROM audit_log WHERE action = 'admin_list_feedback' ORDER BY id");
    assert.equal(a.length, 3);
    assert.equal(a[0].actor, 'admin:' + ADMIN);
    assert.deepEqual(a.map(x => JSON.parse(x.detail).count), [10, 3, 25]);
    D().run('DELETE FROM feedback');
    r = await interact(cmd('feedback'));
    assert.match(r.json.data.content, /No feedback yet/);
});

test('command: /feedback refuses non-admins, the wrong guild and DMs, and audits it', async () => {
    feedback.add({ guestId: hex32('1'), text: 'secret-ish player text' });
    const before = D().get("SELECT count(*) AS n FROM audit_log WHERE action = 'admin_denied'").n;
    for (const [who, guild] of [[OTHER, GUILD], [ADMIN, '999999999999999999'], [ADMIN, null]]) {
        const r = await interact(cmd('feedback', [], who, guild));
        assert.equal(r.json.data.flags, 64);
        assert.match(r.json.data.content, /not allowed/);
        assert.ok(!JSON.stringify(r.json).includes('secret-ish'));
    }
    const denied = D().all("SELECT detail FROM audit_log WHERE action = 'admin_denied' ORDER BY id").slice(before);
    assert.equal(denied.length, 3);
    assert.ok(denied.every(d => JSON.parse(d.detail).command === 'feedback'));
});

test('migration: v7 -> v8 keeps every row, writes a backup, adds feedback', () => {
    const file = path.join(ROOT, 'mig', 'v7.db');
    const db = dbmod.open({ path: file, migrate: false });
    db.tx(() => {
        for (const m of migrations.MIGRATIONS.filter(x => x.version <= 7)) m.up(db);
        db.exec('PRAGMA user_version = 7');
    });
    db.run(`INSERT INTO users (id, public_id, username, username_lc, created_at) VALUES (1, 'DW-CCCCCCCC', 'Keep', 'keep', 1)`);
    for (let i = 1; i <= 25; i++) {
        db.run('INSERT INTO guests (guest_id, first_seen, last_seen, games, source) VALUES (?, 1, 2, ?, ?)', i.toString(16).padStart(32, '0'), i, i % 2 ? 'itch.io' : null);
        db.run("INSERT INTO deaths (at, user_id, cause, life_ms) VALUES (?, 1, 'bot', ?)", i, i * 10);
    }
    const tables = db.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").map(t => t.name);
    const before = {};
    for (const t of tables) before[t] = db.all(`SELECT * FROM "${t}"`);
    assert.equal(db.get("SELECT 1 AS x FROM sqlite_master WHERE name = 'feedback'"), null);
    const res = migrations.apply(db, { backupDir: path.join(ROOT, 'mig', 'backups') });
    assert.deepEqual(res.applied, [8]);
    assert.equal(migrations.latestVersion(), 8);
    assert.ok(res.backup && fs.existsSync(res.backup), 'pre-migration backup');
    assert.match(path.basename(res.backup), /^pre-migrate-v8-/);
    const bk = dbmod.open({ path: res.backup, migrate: false });
    assert.equal(bk.userVersion(), 7);
    assert.equal(bk.get('SELECT count(*) AS n FROM guests').n, 25);
    bk.close();
    assert.equal(db.userVersion(), 8);
    for (const t of tables) assert.deepEqual(db.all(`SELECT * FROM "${t}"`), before[t], t + ' unchanged');
    assert.ok(db.get("SELECT 1 AS x FROM sqlite_master WHERE type = 'index' AND name = 'feedback_at'"));
    assert.throws(() => db.run("INSERT INTO feedback (at, category, text) VALUES (1, 'rant', 'x')"), /CHECK/);
    assert.throws(() => db.run("INSERT INTO feedback (at, text) VALUES (1, '')"), /CHECK/);
    assert.throws(() => db.run("INSERT INTO feedback (at, guest_id, text) VALUES (1, 'short', 'x')"), /CHECK/);
    assert.throws(() => db.run('INSERT INTO feedback (at, text) VALUES (1, ?)', 'x'.repeat(1001)), /CHECK/);
    db.run("INSERT INTO feedback (at, user_id, category, text) VALUES (1, 1, 'bug', 'fine')");
    assert.equal(db.get('SELECT context FROM feedback').context, '{}');
    // a deleted account leaves its feedback behind, unlinked
    db.run('DELETE FROM users WHERE id = 1');
    assert.equal(db.get('SELECT user_id FROM feedback').user_id, null);
    assert.equal(db.get('PRAGMA integrity_check').integrity_check, 'ok');
    assert.deepEqual(migrations.apply(db).applied, []);
    db.close();
});

test('client: the menu has the button, the modal module and the privacy line', () => {
    const PUB = path.join(__dirname, '..', '..', 'public');
    const html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
    assert.match(html, /<button class="social-btn" id="homeFeedbackBtn"[^>]*><svg class="dw-ic"><use href="#i-chat"\/><\/svg><\/button>/);
    const js = fs.readFileSync(path.join(PUB, 'client', 'account', 'feedback.js'), 'utf8');
    assert.ok(js.includes("'Thanks! ZyroX reads every one.'"));
    assert.ok(/import \* as feedback from '\.\/feedback\.js'/.test(fs.readFileSync(path.join(PUB, 'client', 'account', 'main.js'), 'utf8')));
    assert.ok(/sendFeedback = \(body\) => post\('\/api\/feedback', body\)/.test(fs.readFileSync(path.join(PUB, 'client', 'account', 'api.js'), 'utf8')));
    assert.match(fs.readFileSync(path.join(PUB, 'privacy.html'), 'utf8'), /If you send feedback/);
    for (const f of ['feedback.js', 'api.js', 'main.js']) {
        assert.ok(!fs.readFileSync(path.join(PUB, 'client', 'account', f), 'utf8').includes('\u2014'), f + ' has no em dash');
    }
});

// ===================================================================

async function main() {
    const quietLog = console.log, quietWarn = console.warn;
    console.log = (...args) => { if (!/^\[(accounts|backup|discord|clientIp)\]/.test(String(args[0]))) quietLog(...args); };
    console.warn = (...args) => { if (!/^\[(accounts|backup|discord|clientIp)\]/.test(String(args[0]))) quietWarn(...args); };
    assert.equal(accounts.initMain(), true, 'initMain');
    const server = http.createServer((req, res) => { if (!accounts.handleHttp(req, res)) { res.writeHead(404); res.end(); } });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
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
    rest.setFetchForTests(null);
    quietLog(`\n${tests.length - failed}/${tests.length} passed in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    if (!failed) fs.rmSync(ROOT, { recursive: true, force: true });
    else quietLog('test data kept in ' + ROOT);
    process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
