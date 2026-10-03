// Sidekicks: node scripts/test/sidekicks.test.js
//
//   harmless    no entity is ever made for one, so nothing can hit, push,
//               target or count it, and its shots do zero damage (they
//               only exist on the clients)
//   hidden      smoke, burrow, the sky drop, the raid-end freeze and a faded
//               tank all flag the owner hidden; the client draws nothing for
//               a hidden owner or one it isn't drawing
//   follows     it never sits on its owner, stays within the leash while its
//               owner runs about, moves smoothly (frame-rate independent
//               easing, no pops), and only teleports (then fades in) after a
//               huge jump; the barrels turn smoothly, no angle steps
//   looks       twenty plain tanks with one smiley each (no props, no faces
//               to buy), body-only skins, sidekick-only name styles, 25%
//               bigger than the first cut
//   migration   owners of retired items get their dust back once, with
//               ledger rows that add up, and lose the item cleanly
//   lifecycle   a row per live owner, gone on death and leaving, back on
//               respawn; whole table once per socket, then only changes,
//               nothing at all when nothing changes
//   shop        the daily Sidekicks shelf (4 sidekicks, 3 skins, 2 name
//               styles), the Basic one always for sale,
//               buying anything puts it on, gifts and refunds behave
//   name        the Locker name is cleaned, capped at 16 and swear-checked,
//               and an old name that fails today is dropped at spawn
//   switch      ROYALE_SIDEKICKS=0 turns them off
//
// A throwaway database under the OS temp dir (or $DATA_DIR), removed when
// everything passes. No game server.
'use strict';

const emit = process.emitWarning;
process.emitWarning = (w, ...a) => { if (!/MODULE_TYPELESS|module syntax/.test(String(w) + a.join(' '))) emit.call(process, w, ...a); };

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..', '..');
const SERVER = path.join(REPO, 'server');

if (process.argv[2] === '--off') {
    process.env.ROYALE_SIDEKICKS = '0';
    global.Config = { dig_royale: true };
    const sk = require(path.join(SERVER, 'game', 'terrain', 'sidekicks.js'));
    const said = [];
    const sock = { status: { verified: true }, talk: (...a) => said.push(a) };
    const b = { id: 7, sidekick: { nid: 201, skin: 0, ns: 0, name: 'Buddy', color: '' }, socket: sock, isDead: () => false };
    sk.tick(1e6, [b], [sock]);
    process.stdout.write(JSON.stringify({ on: sk.enabled(), rows: sk.snapshot().length, packets: said.length }));
    process.exit(0);
}

const ROOT = process.env.DATA_DIR
    ? path.join(process.env.DATA_DIR, `sidekicks-test-${process.pid}-${Date.now()}`)
    : fs.mkdtempSync(path.join(os.tmpdir(), 'dw-sidekicks-test-'));
process.env.DATA_DIR = path.join(ROOT, 'data');
delete process.env.DB_PATH;
delete process.env.PUBLIC_HOST;
delete process.env.PUBLIC_ORIGIN;
delete process.env.ALLOWED_ORIGINS;
delete process.env.SHOP_SEED_SALT;
delete process.env.ROYALE_SIDEKICKS;
process.env.NODE_ENV = 'test';
process.env.ACCOUNTS_ENABLED = 'true';
process.env.SESSION_SECRET = 'sidekicks-test-secret-0123456789-abcdefghij';

global.Config = { dig_royale: true };
global.entities = global.entities || new Map();

const C = require(path.join(REPO, 'shared', 'cosmetics.js'));
const accounts = require(path.join(SERVER, 'accounts'));
const store = require(path.join(SERVER, 'accounts', 'store'));
const sidekicks = require(path.join(SERVER, 'game', 'terrain', 'sidekicks.js'));
const users = accounts.users;
const migrations = require(path.join(SERVER, 'accounts', 'migrations.js'));

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const TODAY = 20730;
const NOW = TODAY * DAY + 5 * HOUR;

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
const d = () => accounts.db.handle();
let seq = 0, keyN = 0;
function mkUser(dustMilli = 10000000) {
    const r = users.create({ username: 'kick' + (++seq) + 'x', recoveryHash: null, now: NOW - 10 * DAY });
    assert.ok(r.ok, 'user created');
    d().run('UPDATE users SET dust_milli = ? WHERE id = ?', dustMilli, r.user.id);
    return users.byId(r.user.id);
}
const key = () => 'sk-key-' + (++keyN).toString().padStart(4, '0');
function code(fn) {
    try { fn(); } catch (e) { return e.status + ':' + e.code; }
    return 'ok';
}
const buy = (u, id) => store.purchase(u.id, { itemId: id, day: TODAY, idempotencyKey: key() }, { now: NOW });
const shelf = () => store.rotationFor(TODAY, 2, NOW).sidekicks;

// ── game side: plain bodies and sockets ───────────────────────────────
function sock() { const s = { said: [], status: { verified: true }, terminated: false }; s.talk = (...a) => s.said.push(a); return s; }
let ids = 1000;
function owner(extra = {}) {
    const b = { id: ++ids, x: 0, y: 0, alpha: 1, dead: false, socket: sock(), sidekick: { nid: 217, skin: 316, ns: 409, name: 'Pumpkin', color: '#ff9f43' }, ...extra };
    b.isDead = () => b.dead;
    return b;
}
const SK = (s) => s.said.filter(p => p[0] === 'SK').map(p => JSON.parse(p[1]));
let clock = 5e6;
const tick = (bodies, clients) => { clock += sidekicks.EVERY_MS; sidekicks.tick(clock, bodies, clients); };

// ── harmless ──────────────────────────────────────────────────────────
test('harmless: a sidekick is a table row, never an entity (no damage, no hits, no targeting)', () => {
    sidekicks.reset();
    const before = global.entities.size;
    const o = owner(), viewer = sock();
    tick([o], [o.socket, viewer]);
    assert.equal(global.entities.size, before, 'nothing was added to the world');
    const rows = sidekicks.snapshot();
    assert.equal(rows.length, 1);
    // the row only says what to draw: owner id, looks, name, hidden
    assert.deepEqual(rows[0], [o.id, 217, 316, 409, '#ff9f43', 'Pumpkin', 0]);
    // and the module can't reach the world: no Entity, no damage, no kill
    const src = fs.readFileSync(path.join(SERVER, 'game', 'terrain', 'sidekicks.js'), 'utf8').replace(/\/\/.*$/gm, '');
    for (const word of ['new Entity', 'entities', '.damage', '.kill(', 'health', 'collisionArray', 'velocity']) assert.ok(!src.includes(word), 'sidekicks.js touches ' + word);
    // nothing for bots, turrets, radar, hunted, bounty or the board to find
    for (const f of [['..', 'miscFiles', 'controllers.js'], ['entities', 'entity.js'], ['entities', 'bulletEntity.js'], ['terrain', 'hunted.js'], ['terrain', 'abilities.js'], ['terrain', 'gems.js'], ['terrain', 'bosses.js'], ['terrain', 'coreFinale.js']]) {
        const src = fs.readFileSync(path.join(SERVER, 'game', ...f), 'utf8');
        assert.ok(!/sidekick/i.test(src), f[f.length - 1] + ' knows nothing about sidekicks');
    }
    sidekicks.reset();
});

test('harmless: its shots live only on the client and carry no damage', async () => {
    const M = await import(pathToFileURL(path.join(REPO, 'public', 'client', 'sidekickMath.js')).href);
    for (const move of ['orbit', 'spin']) {
        const st = M.makeState(5, move);
        let shots = 0, last = -1, gaps = [];
        for (let t = 0; t < 60; t += 1 / 60) {
            M.step(st, 0, 0, 30, 0, 1, t, 1 / 60);
            const a = M.shotDue(st, t, Math.random);
            if (a === a) { shots++; if (last >= 0) gaps.push(t - last); last = t; }
        }
        // a steady, easy rhythm: a pop every 1.5 to 3 s
        assert.ok(gaps.length > 10 && gaps.every(g => g >= 1.5 - 0.02 && g <= 3 + 0.02), move + ' gaps ' + gaps.map(g => g.toFixed(2)));
        assert.ok(shots >= 60 / 3 - 1 && shots <= 60 / 1.5 + 1, 'shots in a minute: ' + shots);
    }
    // the barrels have swung to a shot's direction by the time it goes
    {
        const st = M.makeState(9, 'orbit');
        let worst = 0, n = 0;
        for (let t = 0; t < 40; t += 1 / 60) {
            M.step(st, 0, 0, 30, 2.5, 1, t, 1 / 60);
            const aim = st.aim, firing = st.firing;
            const a = M.shotDue(st, t, Math.random);
            if (a === a && firing) { n++; worst = Math.max(worst, Math.abs(((a - aim) % (2 * Math.PI) + 3 * Math.PI) % (2 * Math.PI) - Math.PI)); }
        }
        assert.ok(n > 8 && worst < 0.2, 'aimed within ' + worst.toFixed(3) + ' rad over ' + n + ' shots');
    }
    const client = fs.readFileSync(path.join(REPO, 'public', 'client', 'sidekicks.js'), 'utf8');
    assert.ok(!/talk\(|socket\.|cmd\./.test(client), 'the client never tells the server about a shot');
    assert.ok(M.SHOT_LIFE < 0.5, 'shots fade fast');
});

// ── hidden ────────────────────────────────────────────────────────────
test('hidden: smoke, burrow, the sky drop, the freeze and a faded tank flag the owner', () => {
    sidekicks.reset();
    const o = owner(), viewer = sock();
    tick([o], [o.socket, viewer]);
    const cases = [
        ['smoke', () => { o.smokeHidden = true; }, () => { o.smokeHidden = false; }],
        ['burrow', () => { o.burrowUntil = clock + 5000; }, () => { o.burrowUntil = 0; }],
        ['sky drop', () => { o._dropHoldUntil = clock + 1500; }, () => { o._dropHoldUntil = 0; }],
        ['raid-end freeze', () => { o.royaleFrozen = true; }, () => { o.royaleFrozen = false; }],
        ['invisible', () => { o.alpha = 0.3; }, () => { o.alpha = 1; }],
    ];
    for (const [what, on, off] of cases) {
        viewer.said.length = 0;
        on(); tick([o], [o.socket, viewer]);
        assert.equal(sidekicks.snapshot()[0][6], 1, what + ' hides it');
        assert.deepEqual(SK(viewer).pop().h, [[o.id, 1]], what + ': the flip is sent');
        off(); tick([o], [o.socket, viewer]);
        assert.equal(sidekicks.snapshot()[0][6], 0, what + ' over');
    }
    // a burrow that has run out is not hidden any more, even before it's cleared
    o.burrowUntil = clock - 1; tick([o], [o.socket, viewer]);
    assert.equal(sidekicks.snapshot()[0][6], 0);
    sidekicks.reset();
});

test('hidden: the client only draws one where its owner is drawn, at full strength', async () => {
    const M = await import(pathToFileURL(path.join(REPO, 'public', 'client', 'sidekickMath.js')).href);
    assert.equal(M.shown(false, 1, 1, false, false), true);
    assert.equal(M.shown(true, 1, 1, false, false), false, 'server says hidden (smoke, burrow)');
    assert.equal(M.shown(false, 0.35, 1, false, false), false, 'your own tank as a ghost in smoke');
    assert.equal(M.shown(false, 0.6, 1, false, false), false, 'burrowed tank at 0.6');
    assert.equal(M.shown(false, 0, 1, false, false), false, 'invisible');
    assert.equal(M.shown(false, 1, 0.5, false, false), false, 'dying (fading out)');
    assert.equal(M.shown(false, 1, 1, true, false), false, 'falling out of the sky');
    assert.equal(M.shown(false, 1, 1, false, true), false, 'raid over');
    // and the runtime calls it for every owner, from the tank pass only
    const rt = fs.readFileSync(path.join(REPO, 'public', 'client', 'sidekicks.js'), 'utf8');
    assert.match(rt, /e\.ok = M\.shown\(e\.hidden, alpha, fade, falling, raidFinale\.active\(\)\)/);
    assert.match(rt, /e\.frame !== frame \|\| !e\.ok/, 'nothing drawn unless the owner was drawn this frame');
    const app = fs.readFileSync(path.join(REPO, 'public', 'client', 'app.js'), 'utf8');
    assert.match(app, /sidekicks\.note\(instance, x, y, instance\.alpha \* alpha, rst,/, 'noted right where the tank is drawn');
    // the server's view filter never sends a smoked tank to an enemy at all
    const so = fs.readFileSync(path.join(SERVER, 'game', 'network', 'sockets.js'), 'utf8');
    assert.match(so, /\.smokeView\(player\.body, smoked\)/);
});

// ── follows ───────────────────────────────────────────────────────────
test('follows: never on its owner, on the leash, smooth, teleports (and fades in) only on a huge jump', async () => {
    const M = await import(pathToFileURL(path.join(REPO, 'public', 'client', 'sidekickMath.js')).href);
    const oR = 30;
    for (const move of Object.keys(M.MOVES)) {
        for (const size of [1, 1.08]) {
            const st = M.makeState(11, move);
            const r = M.R * size;
            let ox = 0, oy = 0, vx = 0, vy = 0, t = 0, near = Infinity, worst = 0, jerk = 0;
            const sp = [], op = [];
            // run in circles and zigzags, then drive straight at it, at 240
            // units a second (a tank speeds up, it doesn't teleport its
            // velocity), for 20 s at 60 fps
            for (let i = 0; i < 1200; i++) {
                t += 1 / 60;
                let wx, wy;
                if (i % 300 < 200) { wx = Math.cos(t * 0.7) * 4; wy = Math.sin(t * 1.3) * 4; }
                else { const dx = st.x - ox, dy = st.y - oy, dd = Math.hypot(dx, dy) || 1; wx = dx / dd * 4; wy = dy / dd * 4; }
                vx += (wx - vx) * 0.12; vy += (wy - vy) * 0.12;
                ox += vx; oy += vy;
                M.step(st, ox, oy, oR, 0, size, t, 1 / 60);
                const d = Math.hypot(st.x - ox, st.y - oy);
                near = Math.min(near, d); worst = Math.max(worst, d);
                // a pop is a sudden change of velocity: compare its frame to
                // frame acceleration with its owner's
                sp.push([st.x, st.y]); op.push([ox, oy]);
                if (sp.length > 3) { sp.shift(); op.shift(); }
                if (sp.length === 3) {
                    const acc = (q) => Math.hypot(q[2][0] - 2 * q[1][0] + q[0][0], q[2][1] - 2 * q[1][1] + q[0][1]);
                    jerk = Math.max(jerk, acc(sp) - acc(op));
                }
                assert.ok(Number.isFinite(st.x) && Number.isFinite(st.face), move + ' stays finite');
            }
            assert.ok(near >= oR + r + M.CLEAR - 1e-6, move + ' got within ' + near.toFixed(1) + ' of its owner');
            assert.ok(worst <= oR + M.LEASH + 1e-6, move + ' strayed ' + Math.round(worst));
            // no pops: its velocity never changes much faster than its owner's
            assert.ok(jerk < 1.2, move + ' popped (' + jerk.toFixed(2) + ' units/frame²)');
            // a dash straight through it at 600 a second: shoved aside, never under the tank
            for (let i = 0; i < 40; i++) {
                const dx = st.x - ox, dy = st.y - oy, dd = Math.hypot(dx, dy) || 1;
                ox += dx / dd * 10; oy += dy / dd * 10; t += 1 / 60;
                M.step(st, ox, oy, oR, 0, size, t, 1 / 60);
                assert.ok(Math.hypot(st.x - ox, st.y - oy) >= oR + r + M.CLEAR - 1e-6, move + ' got run over');
            }
            assert.equal(st.snaps, 0, move + ' never teleported while running about');
            // a shockwave fling / launch pad / grapple / respawn: 900 units in one step
            ox += 900; t += 1 / 60;
            M.step(st, ox, oy, oR, 0, size, t, 1 / 60);
            assert.equal(st.snaps, 1, move + ' teleported');
            assert.ok(Math.hypot(st.x - ox, st.y - oy) <= oR + M.GAP + r * 1.5 + 12, move + ' is right back beside it');
            assert.ok(st.alpha < 0.1, move + ' fades back in');
            for (let i = 0; i < 30; i++) { t += 1 / 60; M.step(st, ox, oy, oR, 0, size, t, 1 / 60); }
            assert.equal(st.alpha, 1, move + ' faded in within half a second');
        }
    }
    // frame-rate independent: 30, 60 and 144 fps end up in the same place
    const at = (fps) => {
        const st = M.makeState(4, 'orbit');
        for (let i = 1; i <= 6 * fps; i++) { const t = i / fps; M.step(st, 140 * t, 0, oR, 0.5, 1, t, 1 / fps); }
        return st;
    };
    const a30 = at(30), a60 = at(60), a144 = at(144);
    assert.ok(Math.hypot(a30.x - a144.x, a30.y - a144.y) < 3 && Math.hypot(a60.x - a144.x, a60.y - a144.y) < 1.5, 'same path at any frame rate');
    assert.ok(Math.abs(a30.face - a144.face) < 0.05, 'same aim at any frame rate');
    // a long frame (tab in the background) never throws it off
    const st = M.makeState(3, 'zip');
    M.step(st, 0, 0, oR, 0, 1, 0, 1 / 30);
    M.step(st, 50, 0, oR, 0, 1, 5, 5);
    assert.ok(Math.hypot(st.x - 50, st.y) <= oR + M.LEASH && Math.hypot(st.x - 50, st.y) >= oR + M.R + M.CLEAR - 1e-6);
    // every design's move exists
    for (const it of C.ITEMS.filter(i => i.cat === 'sidekick')) assert.ok(M.MOVES[it.kick.move], it.id + ' move ' + it.kick.move);
    // the game follows the owner where it is drawn (renderx / rendery for
    // your own tank): the camera goes in so the spot can be turned back
    // into world units
    const app = fs.readFileSync(path.join(REPO, 'public', 'client', 'app.js'), 'utf8');
    assert.match(app, /sidekicks\.draw\(ctx\[1\], ratio, px, py\)/);
    const rt = fs.readFileSync(path.join(REPO, 'public', 'client', 'sidekicks.js'), 'utf8');
    assert.match(rt, /e\.wx = \(e\.ox - hw \+ px\) \/ ratio/);
});

test('turning: barrels turn smoothly, one rotated drawImage a frame, no baked angle steps', async () => {
    const M = await import(pathToFileURL(path.join(REPO, 'public', 'client', 'sidekickMath.js')).href);
    for (const move of ['orbit', 'spin']) {
        const st = M.makeState(2, move);
        let biggest = 0, prev = null;
        for (let t = 0; t < 30; t += 1 / 60) {
            M.step(st, 0, 0, 30, Math.sin(t) * 3, 1, t, 1 / 60);
            M.shotDue(st, t, Math.random);
            if (prev !== null) biggest = Math.max(biggest, Math.abs(st.face - prev));
            prev = st.face;
        }
        // at most ~a fifth of a radian a frame even mid-swing (the old sprites stepped 15 degrees)
        assert.ok(biggest < 0.2, move + ' turned ' + biggest.toFixed(3) + ' rad in one frame');
    }
    const rt = fs.readFileSync(path.join(REPO, 'public', 'client', 'sidekicks.js'), 'utf8');
    assert.ok(!/ANGLES|STEP_A/.test(rt), 'no angle table');
    assert.match(rt, /c\.rotate\(a\);\s*c\.drawImage\(cv, -w \/ 2, -w \/ 2, w, w\)/, 'one rotated blit');
});

// ── looks ─────────────────────────────────────────────────────────────
test('looks: twenty plain tanks with one smiley, body-only skins, sidekick-only name styles', async () => {
    const M = await import(pathToFileURL(path.join(REPO, 'public', 'client', 'sidekickMath.js')).href);
    const kicks = C.ITEMS.filter(i => i.cat === 'sidekick');
    assert.ok(kicks.length >= 18 && kicks.length <= 22, kicks.length + ' sidekicks');
    assert.ok(Math.abs(M.R - 11 * 1.25) < 1e-9, 'a quarter bigger than the first cut');
    for (const it of kicks) {
        const k = it.kick;
        assert.ok(['circle', 'pumpkin', 'smasher'].includes(k.body), it.id + ' body');
        assert.ok(!k.props && !k.face && !k.pat && !k.gun && !k.gunPat, it.id + ' is a plain tank');
        for (const g of k.guns) {
            assert.ok(g[1] <= 2.1, it.id + ' no long sniper barrels');
            // centred: a barrel off the middle line has its mirror twin
            if (g[4]) assert.ok(k.guns.some(o => o !== g && o[0] === g[0] && o[1] === g[1] && Math.abs(o[4] + g[4]) < 1e-9), it.id + ' is symmetric');
        }
    }
    const by = (id) => C.byId(id).kick;
    assert.ok(by('sd_jack').body === 'pumpkin', 'Jack stays');
    assert.ok(by('sd_octo').guns.length === 8, 'Mini Octo stays');
    assert.ok(by('sd_rocket').guns.some(g => g[5] === 'launch'), 'Rocket is a launcher tank');
    assert.ok(by('sd_closer').guns.length === 1 && /^#ff[d-f]/.test(by('sd_closer').col), 'Arena Closer: yellow, one barrel');
    assert.ok(C.byId(C.BASIC_SIDEKICK_ID).permanent, 'Buddy is always in the shop');
    for (const id of Object.keys(C.RETIRED)) assert.equal(C.byId(id), null, id + ' is gone');
    // skins paint the body; nothing can change the face
    const skins = C.ITEMS.filter(i => i.cat === 'sdSkin');
    assert.ok(skins.length >= 7 && skins.length <= 9, skins.length + ' skins');
    for (const s of skins) assert.ok(s.look.fill && !s.look.face && !s.look.hat, s.id + ' is body only');
    const art = fs.readFileSync(path.join(REPO, 'public', 'client', 'sidekickArt.js'), 'utf8');
    assert.match(art, /export function drawFace\(c, r\)/, 'the face takes no options');
    assert.match(art, /drawFace\(c, r\);\n\}/, 'and every body ends with it');
    // name styles of their own
    const names = C.ITEMS.filter(i => i.cat === 'sdName');
    assert.ok(names.length >= 4 && names.length <= 5);
    const kinds = new Set(C.ITEMS.filter(i => i.cat === 'nameStyle').map(i => i.style.kind));
    for (const n of names) assert.ok(!kinds.has(n.style.kind), n.id + ' is not a player name style');
});

// ── lifecycle ─────────────────────────────────────────────────────────
test('lifecycle: removed on death and on leaving, back on respawn', () => {
    sidekicks.reset();
    const a = owner(), b = owner(), viewer = sock();
    tick([a, b], [a.socket, b.socket, viewer]);
    assert.equal(sidekicks.snapshot().length, 2);
    viewer.said.length = 0;
    a.dead = true;
    tick([a, b], [a.socket, b.socket, viewer]);
    assert.deepEqual(sidekicks.snapshot().map(r => r[0]), [b.id], 'gone with its owner');
    assert.deepEqual(SK(viewer).pop().d, [a.id]);
    // dig_royale drops it the moment the owner dies (onCombatantDead)
    sidekicks.drop(b);
    assert.equal(sidekicks.snapshot().length, 0);
    const royale = fs.readFileSync(path.join(SERVER, 'game', 'gamemodes', 'scripts', 'dig_royale.js'), 'utf8');
    assert.match(royale, /if \(body\.sidekick\) guard\('sidekick drop', \(\) => sidekicks\.drop\(body\)\)/);
    // respawn: a new body, a new row
    const a2 = owner({ socket: a.socket });
    tick([a2], [a.socket, viewer]);
    assert.deepEqual(sidekicks.snapshot().map(r => r[0]), [a2.id]);
    // leaving: the socket closes
    a.socket.terminated = true;
    tick([a2], [viewer]);
    assert.equal(sidekicks.snapshot().length, 0);
    // a body without one (guests, bots) never gets a row
    tick([owner({ sidekick: null })], [viewer]);
    assert.equal(sidekicks.snapshot().length, 0);
    sidekicks.reset();
});

test('network: the whole table once per socket, then changes only, nothing when idle', () => {
    sidekicks.reset();
    const a = owner(), early = sock(), old = sock();
    early.status.verified = false;
    tick([], [old]);
    tick([a], [a.socket, old, early]);
    assert.equal(SK(early).length, 0, 'nothing before the handshake');
    assert.deepEqual(SK(old).pop().a.map(r => r[0]), [a.id], 'an existing socket gets the add');
    assert.ok(SK(a.socket).pop().f, 'a new socket gets the whole table');
    early.status.verified = true;
    tick([a], [a.socket, old, early]);
    assert.equal(SK(early).pop().f.length, 1, 'once verified, the whole table');
    const counts = [a.socket, old, early].map(s => s.said.length);
    for (let i = 0; i < 50; i++) tick([a], [a.socket, old, early]);
    assert.deepEqual([a.socket, old, early].map(s => s.said.length), counts, 'five idle seconds cost nothing');
    // a full table is small: 20 owners well under 2 KB
    const many = [];
    for (let i = 0; i < 20; i++) many.push(owner({ sidekick: { nid: 221 + i, skin: 310, ns: 411, name: 'Sixteen letters!', color: '#c084fc' } }));
    const fresh = sock();
    tick(many, [fresh]);
    assert.ok(fresh.said[0][1].length < 2000, 'full table ' + fresh.said[0][1].length + ' bytes');
    sidekicks.reset();
});

// ── shop ──────────────────────────────────────────────────────────────
test('shop: a daily Sidekicks shelf (4 sidekicks, 3 skins, 2 name styles), Basic always for sale', () => {
    const rot = store.rotationFor(TODAY, 2, NOW);
    assert.equal(rot.sidekicks.length, store.SIDEKICK_COUNT + store.SIDEKICK_EXTRAS);
    const cats = rot.sidekicks.map(id => C.byId(id).cat);
    assert.deepEqual(cats, ['sidekick', 'sidekick', 'sidekick', 'sidekick', 'sdSkin', 'sdSkin', 'sdSkin', 'sdName', 'sdName']);
    assert.ok(!rot.sidekicks.includes(C.BASIC_SIDEKICK_ID), 'Basic sits on the shelf every day instead');
    assert.ok(![...rot.featured, ...rot.daily].some(id => C.SIDEKICK_CATS.includes(C.byId(id).cat)), 'Featured and Daily stay tank items');
    // it changes day to day, and it's stored
    assert.notDeepEqual(store.rotationFor(TODAY + 1, 2, NOW).sidekicks, rot.sidekicks);
    assert.deepEqual(store.readRotation(TODAY).sidekicks, rot.sidekicks);
    // a row from before the shelf existed gets one, once
    store.rotationFor(TODAY - 5, 2, NOW);
    d().run('UPDATE shop_rotations SET sidekicks = NULL WHERE day = ?', TODAY - 5);
    const old = store.readRotation(TODAY - 5);
    assert.equal(old.sidekicks.length, 9);
    assert.deepEqual(store.readRotation(TODAY - 5).sidekicks, old.sidekicks);
    // every sidekick, face and name style turns up within a season
    const seen = new Set();
    const from = Math.ceil(Date.UTC(2026, 9, 6) / 864e5);
    for (let day = from; day < from + 120; day++) store.generateSidekicks(day).forEach(id => seen.add(id));
    // Jack is the Raid Night prize: off the shelf until Oct 6
    for (let day = from - 4; day < from; day++) assert.ok(!store.generateSidekicks(day).includes('sd_jack'), 'Jack held on day ' + day);
    const missing = C.ITEMS.filter(it => C.SIDEKICK_CATS.includes(it.cat) && !it.permanent && !seen.has(it.id)).map(it => it.id);
    assert.deepEqual(missing, []);
    // storeView has the shelf; the Basic one is in permanent
    const u = mkUser();
    const v = store.storeView(u, NOW);
    assert.deepEqual(v.sidekicks.map(i => i.id), rot.sidekicks);
    assert.ok(v.permanent.some(i => i.id === C.BASIC_SIDEKICK_ID));
    // on the shelf: for sale; off it: not; Basic: any day
    assert.equal(code(() => buy(u, rot.sidekicks[0])), 'ok');
    const off = C.ITEMS.find(it => it.cat === 'sidekick' && !it.permanent && !rot.sidekicks.includes(it.id));
    assert.equal(code(() => buy(u, off.id)), '409:not_in_shop');
    assert.equal(code(() => store.purchase(u.id, { itemId: C.BASIC_SIDEKICK_ID, day: TODAY + 40, idempotencyKey: key() }, { now: NOW + 40 * DAY })), 'ok');
    // an admin re-roll of just the shelf
    const r = store.reroll(TODAY, 'sidekicks', NOW, 'x');
    assert.deepEqual(r.featured, rot.featured);
    assert.notDeepEqual(r.sidekicks, rot.sidekicks);
});

test('shop: buying anything puts it on, sidekicks included; gifts and refunds behave', () => {
    const u = mkUser();
    const rot = store.rotationFor(TODAY, 2, NOW);
    const want = {
        skin: rot.daily.find(id => C.byId(id).cat === 'skin') || rot.featured.find(id => C.byId(id).cat === 'skin'),
        nameStyle: rot.daily.find(id => C.byId(id).cat === 'nameStyle') || rot.featured.find(id => C.byId(id).cat === 'nameStyle'),
        sidekick: rot.sidekicks[1], sdSkin: rot.sidekicks[4], sdName: rot.sidekicks[7],
    };
    for (const [slot, id] of Object.entries(want)) {
        if (!id) continue;
        const res = buy(u, id);
        assert.equal(res.equipped[slot], id, slot + ' on straight away');
        assert.equal(store.equippedOf(users.byId(u.id))[slot], id);
    }
    // the next sidekick bought replaces the last
    buy(u, C.BASIC_SIDEKICK_ID);
    assert.equal(store.equippedOf(users.byId(u.id)).sidekick, C.BASIC_SIDEKICK_ID);
    // what the game gets at spawn
    const sf = store.sidekickFor(users.byId(u.id));
    assert.deepEqual(sf, { nid: C.byId(C.BASIC_SIDEKICK_ID).nid, skin: C.byId(want.sdSkin).nid, ns: C.byId(want.sdName).nid, name: 'Buddy', color: '' });
    // Custom Color goes on once it has a colour
    const r = store.purchase(u.id, { itemId: 'ns_custom', day: TODAY, idempotencyKey: key(), color: '#7ad3ff' }, { now: NOW });
    assert.equal(r.equipped.nameStyle, 'ns_custom');
    // a gift goes in the friend's Locker, not on them
    const friend = mkUser();
    d().run('INSERT INTO friendships (user_lo, user_hi, created_at) VALUES (?, ?, ?)', Math.min(u.id, friend.id), Math.max(u.id, friend.id), NOW - 5 * DAY);
    store.gift(u.id, { itemId: rot.sidekicks[2], day: TODAY, toUserId: friend.public_id, idempotencyKey: key(), preset: 0 }, { now: NOW });
    assert.ok(store.owns(friend.id, rot.sidekicks[2]));
    assert.equal(store.equippedOf(users.byId(friend.id)).sidekick, null);
    // a refund takes it off
    const u2 = mkUser();
    const p = buy(u2, rot.sidekicks[3]);
    assert.equal(store.equippedOf(users.byId(u2.id)).sidekick, rot.sidekicks[3]);
    store.refund(u2.id, p.purchaseId, { now: NOW + 1000 });
    assert.equal(store.equippedOf(users.byId(u2.id)).sidekick, null);
    assert.equal(store.sidekickFor(users.byId(u2.id)), null, 'no sidekick at spawn');
});

// ── the Locker panel ──────────────────────────────────────────────────
test('name: cleaned, capped at 16, swear-checked; colour from the swatches only', () => {
    const u = mkUser();
    buy(u, C.BASIC_SIDEKICK_ID);
    const save = (x) => store.saveSidekick(u.id, Object.assign({ sidekick: C.BASIC_SIDEKICK_ID }, x));
    assert.equal(save({ name: '  Sir   <b>Fluffington</b> the Third ' }).equipped.sidekickName, 'Sir bFluffington');
    assert.equal(C.cleanSidekickName('Sir   <b>Fluffington</b> the Third').length <= C.SIDEKICK_NAME_MAX, true);
    for (const bad of ['fuck', 'Sh1t head', 'b i t c h', 'hitler']) assert.equal(code(() => save({ name: bad })), '400:bad_name', bad);
    assert.equal(code(() => save({ name: '<<<>>>' })), '400:bad_name', 'nothing left of it');
    assert.equal(save({ name: '' }).equipped.sidekickName, null, 'empty: its own name');
    assert.equal(store.sidekickFor(users.byId(u.id)).name, 'Buddy');
    assert.equal(save({ name: 'Pip', color: '#c084fc' }).equipped.sidekickColor, '#c084fc');
    assert.equal(code(() => save({ color: '#123456' })), '400:bad_color');
    assert.equal(code(() => save({ sidekick: 'sd_closer' })), '403:not_owned');
    assert.equal(code(() => save({ sdSkin: 'ns_sunset' })), '400:bad_item');
    assert.equal(save({ sidekick: null }).equipped.sidekick, null, 'none');
    // a name stored before a word was added to the filter is dropped at spawn
    save({ name: 'Pip' });
    d().run("UPDATE users SET sidekick_name = 'fuckface' WHERE id = ?", u.id);
    assert.equal(store.sidekickFor(users.byId(u.id)).name, 'Buddy');
    // the bridge hands it to the body at spawn
    const bridge = fs.readFileSync(path.join(SERVER, 'accounts', 'game', 'bridge.js'), 'utf8');
    assert.match(bridge, /body\.sidekick = accounts\.store\.sidekickFor\(row\)/);
});

// ── migration ─────────────────────────────────────────────────────────
test('migration v11: retired items are refunded once at what was paid, ledger adds up, slots cleared', () => {
    const up = migrations.MIGRATIONS.find(m => m.version === 11).up;
    const u = mkUser(1000), friend = mkUser(500000), granted = mkUser(2000);
    let pid = 0;
    const purchase = (buyer, item, price, gift) => {
        const r = d().run('INSERT INTO purchases (user_id, idem_key, item_id, price_milli, day, is_gift, recipient_id, gift_message, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
            buyer.id, 'old-' + (++pid), item, price, TODAY, gift ? 1 : 0, gift ? gift.id : null, gift ? 0 : null, NOW - DAY);
        return Number(r.lastInsertRowid);
    };
    const own = (who, item, source, p) => d().run('INSERT INTO owned_items (user_id, item_id, source, purchase_id, acquired_at) VALUES (?, ?, ?, ?, ?)', who.id, item, source, p, NOW - DAY);
    // bought a face (80 dust) and a sidekick (150), was gifted a name style (40), and a still-current item stays put
    const p1 = purchase(u, 'sds_party', 75000), p2 = purchase(u, 'sd_spooky', 150000), p3 = purchase(friend, 'sdn_berry', 40000, u);
    own(u, 'sds_party', 'purchase', p1); own(u, 'sd_spooky', 'purchase', p2); own(u, 'sdn_berry', 'gift', p3);
    own(u, 'sd_octo', 'purchase', purchase(u, 'sd_octo', 90000));
    d().run("UPDATE users SET equip_sidekick = 'sd_spooky', equip_sd_skin = 'sds_party', equip_sd_name = 'sdn_berry' WHERE id = ?", u.id);
    // a granted one (free) and an already refunded purchase pay nothing
    own(granted, 'sd_ember', 'grant', null);
    const p4 = purchase(granted, 'sds_wink', 40000);
    d().run('UPDATE purchases SET refunded_at = ? WHERE id = ?', NOW, p4);
    own(granted, 'sds_wink', 'purchase', p4);
    d().run("UPDATE shop_rotations SET sidekicks = '[\"sd_spooky\"]'");
    const before = users.byId(u.id).dust_milli, fBefore = users.byId(friend.id).dust_milli, gBefore = users.byId(granted.id).dust_milli;
    up(d());
    const after = users.byId(u.id);
    assert.equal(after.dust_milli - before, 75000 + 150000 + 40000, 'what was paid, gift included');
    assert.equal(users.byId(friend.id).dust_milli, fBefore, 'the gift giver is not paid twice');
    assert.equal(users.byId(granted.id).dust_milli, gBefore, 'free items pay nothing');
    const led = d().all("SELECT delta_milli, balance_milli, kind, ref FROM dust_ledger WHERE user_id = ? AND ref LIKE 'retired:%' ORDER BY id", u.id);
    assert.equal(led.length, 3);
    assert.ok(led.every(l => l.kind === 'refund'));
    assert.equal(led[led.length - 1].balance_milli, after.dust_milli, 'the last ledger balance is the balance');
    let run = before;
    for (const l of led) { run += l.delta_milli; assert.equal(l.balance_milli, run, 'each row adds up'); }
    assert.ok(d().get('SELECT refunded_at FROM purchases WHERE id = ?', p1).refunded_at, 'bought: marked refunded');
    assert.deepEqual(store.lockerView(after).owned.map(i => i.id), ['sd_octo'], 'only the current item is left');
    assert.equal(after.equip_sidekick, null); assert.equal(after.equip_sd_skin, null); assert.equal(after.equip_sd_name, null);
    assert.equal(store.history(u.id, NOW).entries.find(e => e.purchaseId === p2).name, 'Spooky', 'old receipts keep their names');
    assert.equal(store.history(u.id, NOW).entries.find(e => e.purchaseId === p1).refundable, false, 'and can not be refunded again');
    // once only: running it again pays nothing more
    up(d());
    assert.equal(users.byId(u.id).dust_milli, after.dust_milli);
    // the shelves are drawn again from the new catalog
    assert.ok(!store.readRotation(TODAY).sidekicks.includes('sd_spooky'));
});

// ── switch ────────────────────────────────────────────────────────────
test('switch: ROYALE_SIDEKICKS=0 turns them off; the tutorial never has them', () => {
    const r = spawnSync(process.execPath, ['--no-warnings', __filename, '--off'], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), { on: false, rows: 0, packets: 0 });
    const env = fs.readFileSync(path.join(SERVER, '.env.example'), 'utf8');
    assert.match(env, /^ROYALE_SIDEKICKS=1$/m);
    global.Config.tutorial = true;
    try { assert.equal(sidekicks.enabled(), false); } finally { delete global.Config.tutorial; }
    assert.equal(sidekicks.enabled(), true);
    // the Rattler is gone
    assert.ok(!fs.existsSync(path.join(SERVER, 'game', 'terrain', 'rattler.js')));
});

(async () => {
    const log = console.log, warn = console.warn;
    console.log = (...a) => { if (!String(a[0]).startsWith('[accounts]')) log(...a); };
    console.warn = (...a) => { if (!String(a[0]).startsWith('[accounts]')) warn(...a); };
    assert.equal(accounts.initMain(), true, 'initMain');
    let failed = 0;
    const t0 = Date.now();
    for (const t of tests) {
        try { await t.fn(); log('ok   ' + t.name); }
        catch (e) { failed++; log('FAIL ' + t.name + '\n     ' + (e && e.stack || e)); }
    }
    log(`${tests.length - failed}/${tests.length} passed in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    accounts.shutdown();
    if (!failed) fs.rmSync(ROOT, { recursive: true, force: true });
    else log('test data kept in ' + ROOT);
    process.exit(failed ? 1 : 0);
})();
