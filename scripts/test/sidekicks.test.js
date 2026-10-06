// Sidekicks: node scripts/test/sidekicks.test.js
//
//   harmless    no entity is ever made for one, so nothing can hit, push,
//               target or count it; the client's shots are drawn only
//   digging     it always shoots the rock in front of (else nearest to)
//               its owner, rock only, damage by rarity (Buddy 10% of a
//               bare Pounder shot, the legendaries 72-78%), gems to the
//               owner, no rock-count credit, cheap, ROYALE_SIDEKICK_DIG=0
//   hidden      smoke, burrow, the sky drop, the raid-end freeze and a faded
//               tank all flag the owner hidden; the client draws nothing for
//               a hidden owner or one it isn't drawing
//   follows     it never sits on its owner (at any size), stays within the
//               leash while its owner runs about, trails behind and to one
//               side on the move, potters about and wanders off to sniff at
//               things when its owner stops, and only teleports (then fades
//               in) after a huge jump
//   aim         its barrels never copy its owner's aim: they watch an enemy,
//               a gem, glance up at the owner, or look about with pauses;
//               a small spring, smooth, no angle steps; shots go at the enemy
//   scale       it grows a little with its owner (sqrt, 1x to 1.8x), and
//               so do the gaps, the leash and the name tag
//   smooth      the same at 30, 60 and 144 fps, no stepping, runs on the
//               frame clock and follows where the owner is drawn
//   personality two owners' sidekicks are never in step; it bounces about
//               when its owner banks, kills or picks something up
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

if (process.argv[2] === '--dig-off') {
    process.env.ROYALE_SIDEKICK_DIG = '0';
    global.Config = { dig_royale: true };
    const dig = require(path.join(SERVER, 'game', 'terrain', 'sidekickDig.js'));
    const hits = [];
    global.gameManager = { terrainGrid: { baseRockHealth: 100, nearestRock: () => ({ wx: 50, wy: 0, alive: true, health: 1e3 }), damageRock: (...a) => hits.push(a) } };
    const e = { body: { id: 3, x: 0, y: 0, facing: 0, size: 24 }, kick: { nid: 217 }, hidden: false };
    let changed = 0;
    for (let t = 0; t < 10000; t += 100) if (dig.step(e, t)) changed++;
    process.stdout.write(JSON.stringify({ on: dig.ON, hits: hits.length, changed }));
    process.exit(0);
}
// The real client runtime (public/client/sidekicks.js) on a recording
// canvas, with config / global / raidFinale stubbed: counts the shots it
// draws over 6 s with a rock to mine. argv[3]: 'low' (Low effects, Fewer
// Effects and the auto trim's lowFx all on) or 'normal'.
if (process.argv[2] === '--client-shots') {
    const low = process.argv[3] === 'low';
    const { register } = require('node:module');
    globalThis.__cfg = { graphical: low ? { fxLevel: 0, fewerEffects: true } : { fxLevel: 1, fewerEffects: false } };
    globalThis.__g = { lowFx: low, screenWidth: 800, screenHeight: 600, dropZoom: 1, entities: [], royale: null };
    const stub = (src) => 'data:text/javascript,' + encodeURIComponent(src);
    const STUBS = {
        'config.js': stub('export const config = globalThis.__cfg;'),
        'global.js': stub('export const global = globalThis.__g;'),
        'raidFinale.js': stub('export function active() { return false; }'),
    };
    const hooks = 'const S = ' + JSON.stringify(STUBS) + ';\n' +
        'export async function resolve(spec, ctx, next) { const k = spec.replace(/^.*\\//, ""); if (spec.startsWith("./") && S[k] && /sidekicks\\.js$/.test(ctx.parentURL || "")) return { url: S[k], shortCircuit: true }; return next(spec, ctx); }';
    register('data:text/javascript,' + encodeURIComponent(hooks));
    let arcs = 0;
    const mkCtx = (count) => new Proxy({}, {
        get(o, k) {
            if (k in o) return o[k];
            if (k === 'measureText') return (t) => ({ width: String(t).length * 6, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 });
            if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => ({ addColorStop() {} });
            if (k === 'arc' && count) return () => { arcs++; };
            return () => {};
        },
        set(o, k, v) { o[k] = v; return true; },
    });
    globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => mkCtx(false) }) };
    globalThis.window = { DWCosmetics: require(path.join(REPO, 'shared', 'cosmetics.js')) };
    let fakeNow = 1000;
    Object.defineProperty(performance, 'now', { value: () => fakeNow, configurable: true });
    (async () => {
        const sk = await import(pathToFileURL(path.join(REPO, 'public', 'client', 'sidekicks.js')).href);
        sk.onPacket({ f: [[5, 217, 0, 0, '', 'Buddy', 0]], t: [[5, 260, 40]] });
        const c = mkCtx(true), inst = { id: 5, size: 24, render: { x: 0, y: 0 } };
        for (let i = 0; i < 360; i++) {
            fakeNow += 1000 / 60;
            sk.note(inst, 400, 300, 1, 1, 24, false);
            sk.draw(c, 1, 0, 0, fakeNow, 99);
        }
        process.stdout.write(JSON.stringify({ rows: sk.count(), dig: sk.digOf(5), arcs }));
        process.exit(0);
    })().catch((e) => { process.stderr.write(String(e && e.stack || e)); process.exit(1); });
    return;
}
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
const angDiff = (a, b) => Math.abs(((a - b) % (2 * Math.PI) + 3 * Math.PI) % (2 * Math.PI) - Math.PI);
const mathMod = () => import(pathToFileURL(path.join(REPO, 'public', 'client', 'sidekickMath.js')).href);
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
    // the digging touches rock and nothing else
    const digSrc = fs.readFileSync(path.join(SERVER, 'game', 'terrain', 'sidekickDig.js'), 'utf8').replace(/\/\/.*$/gm, '');
    for (const word of ['new Entity', 'entities', '.kill(', 'collisionArray', 'velocity', 'getEntities', 'bosses', 'chests']) assert.ok(!digSrc.includes(word), 'sidekickDig.js touches ' + word);
    assert.deepEqual(digSrc.match(/\.damage\w*\(/g), ['.damageRock('], 'its only damage is damageRock');
    sidekicks.reset();
});

test('harmless: the client\'s own shots are drawn only and never reported to the server', async () => {
    const M = await import(pathToFileURL(path.join(REPO, 'public', 'client', 'sidekickMath.js')).href);
    for (const move of ['orbit', 'spin']) {
        const st = M.makeState(5, move);
        let shots = 0, last = -1, gaps = [];
        for (let t = 0; t < 60; t += 1 / 60) {
            M.step(st, 0, 0, 30, 1, t, 1 / 60);
            const a = M.shotDue(st, t, Math.random);
            if (a === a) { shots++; if (last >= 0) gaps.push(t - last); last = t; }
        }
        // a steady, easy rhythm: a pop every 1.5 to 3 s
        assert.ok(gaps.length > 10 && gaps.every(g => g >= 1.5 - 0.02 && g <= 3 + 0.02), move + ' gaps ' + gaps.map(g => g.toFixed(2)));
        assert.ok(shots >= 60 / 3 - 1 && shots <= 60 / 1.5 + 1, 'shots in a minute: ' + shots);
    }
    // the barrels have swung to a shot's direction by the time it goes; with
    // an enemy about (circling it), that direction is the enemy
    for (const enemy of [false, true]) for (const move of ['orbit', 'spin']) {
        const st = M.makeState(9, move);
        const sense = { ex: NaN, ey: NaN, gx: NaN, gy: NaN };
        let worst = 0, n = 0, off = 0;
        for (let t = 0; t < 40; t += 1 / 60) {
            if (enemy) { sense.ex = Math.cos(t * 0.3) * 300; sense.ey = Math.sin(t * 0.3) * 300; }
            M.step(st, 0, 0, 30, 1, t, 1 / 60, sense);
            const aim = st.aim, firing = st.firing;
            const a = M.shotDue(st, t, Math.random);
            if (a === a && (firing || enemy)) {
                n++; worst = Math.max(worst, angDiff(a, aim));
                if (enemy) off = Math.max(off, angDiff(a, Math.atan2(sense.ey - st.y, sense.ex - st.x)));
            }
        }
        if (move === 'orbit' || enemy) assert.ok(n > 8 && worst < 0.2, move + ' aimed within ' + worst.toFixed(3) + ' rad over ' + n + ' shots');
        if (enemy) assert.ok(off < 0.2, move + ' shot ' + off.toFixed(3) + ' rad off the enemy');
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
// An owner that drives like a tank: its velocity eases toward `want(t)`.
// Worked out on a fine 1440 Hz grid and read at the frame times, so 30,
// 60 and 144 fps all see the very same owner.
function drive(want, fps, rate = 8) {
    let x = 0, y = 0, vx = 0, vy = 0, n = 0;
    const H = 1440, k = 1 - Math.exp(-rate / H);
    return (t) => {
        for (const end = Math.round(t * H); n < end; n++) {
            const w = want(n / H);
            vx += (w[0] - vx) * k; vy += (w[1] - vy) * k; x += vx / H; y += vy / H;
        }
        return [x, y, vx, vy];
    };
}

test('follows: never on its owner at any size, on the leash, no pops, teleports (and fades in) only on a huge jump', async () => {
    const M = await mathMod();
    for (const move of Object.keys(M.MOVES)) {
        for (const [oR, size] of [[24, 1], [30, 1.08], [60, 1], [110, 1.08], [180, 1]]) {
            const st = M.makeState(11, move);
            // (the menu stage's `show` path keeps a fresh tank's scale)
            const sc = move === 'show' ? 1 : M.ownerScale(oR), r = M.R * size * sc;
            const lo = oR + r + M.CLEAR * sc, hi = oR + M.LEASH * sc;
            const sense = { ex: NaN, ey: NaN, gx: NaN, gy: NaN, gr: 10 };
            let ox = 0, oy = 0, vx = 0, vy = 0, t = 0, near = Infinity, worst = 0, jerk = 0;
            const sp = [], op = [];
            // run in circles and zigzags, then drive straight at it, at 240
            // units a second (a tank speeds up, it doesn't teleport its
            // velocity), stopping now and then so it wanders off, with a gem
            // about, for 30 s at 60 fps
            for (let i = 0; i < 1800; i++) {
                t += 1 / 60;
                let wx, wy;
                const ph = i % 600;
                if (ph >= 400) { wx = 0; wy = 0; }
                else if (ph < 250) { wx = Math.cos(t * 0.7) * 4; wy = Math.sin(t * 1.3) * 4; }
                else { const dx = st.x - ox, dy = st.y - oy, dd = Math.hypot(dx, dy) || 1; wx = dx / dd * 4; wy = dy / dd * 4; }
                vx += (wx - vx) * 0.12; vy += (wy - vy) * 0.12;
                ox += vx; oy += vy;
                sense.gx = ox + 90 * sc; sense.gy = oy - 60 * sc;
                M.step(st, ox, oy, oR, size, t, 1 / 60, sense);
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
                assert.ok(Number.isFinite(st.x) && Number.isFinite(st.face) && Number.isFinite(st.hop), move + ' stays finite');
            }
            const tag = move + ' (owner ' + oR + ')';
            assert.ok(near >= lo - 1e-6, tag + ' got within ' + near.toFixed(1) + ' of its owner (floor ' + lo.toFixed(1) + ')');
            assert.ok(near - oR - r >= M.CLEAR * sc - 1e-6, tag + ' overlaps the hull');
            assert.ok(worst <= hi + 1e-6, tag + ' strayed ' + Math.round(worst));
            // no pops: its velocity never changes much faster than its owner's
            assert.ok(jerk < 1.2, tag + ' popped (' + jerk.toFixed(2) + ' units/frame²)');
            // a dash straight through it at 600 a second: shoved aside, never under the tank
            for (let i = 0; i < 40; i++) {
                const dx = st.x - ox, dy = st.y - oy, dd = Math.hypot(dx, dy) || 1;
                ox += dx / dd * 10; oy += dy / dd * 10; t += 1 / 60;
                M.step(st, ox, oy, oR, size, t, 1 / 60);
                assert.ok(Math.hypot(st.x - ox, st.y - oy) >= lo - 1e-6, tag + ' got run over');
            }
            assert.equal(st.snaps, 0, tag + ' never teleported while running about');
            // a shockwave fling / launch pad / grapple / respawn: 900 units in one step
            ox += 900; t += 1 / 60;
            M.step(st, ox, oy, oR, size, t, 1 / 60);
            assert.equal(st.snaps, 1, tag + ' teleported');
            const back = Math.hypot(st.x - ox, st.y - oy);
            assert.ok(back >= lo && back <= (oR + M.GAP * sc + r) * 1.25, tag + ' is right back beside it (' + back.toFixed(1) + ')');
            assert.ok(st.alpha < 0.1, tag + ' fades back in');
            for (let i = 0; i < 30; i++) { t += 1 / 60; M.step(st, ox, oy, oR, size, t, 1 / 60); }
            assert.equal(st.alpha, 1, tag + ' faded in within half a second');
        }
    }
    // a long frame (tab in the background) never throws it off
    const st = M.makeState(3, 'zip');
    M.step(st, 0, 0, 30, 1, 0, 1 / 30);
    M.step(st, 50, 0, 30, 1, 5, 5);
    const d = Math.hypot(st.x - 50, st.y);
    assert.ok(d <= 30 + M.LEASH * M.ownerScale(30) && d >= 30 + M.R * M.ownerScale(30) + M.CLEAR - 1e-6);
    // every design's move exists
    for (const it of C.ITEMS.filter(i => i.cat === 'sidekick')) assert.ok(M.MOVES[it.kick.move], it.id + ' move ' + it.kick.move);
});

test('follows: trails behind and to one side on the move, keeps up at a run, never in front', async () => {
    const M = await mathMod();
    for (const move of ['orbit', 'zip', 'bounce', 'guard', 'hover']) {
        const st = M.makeState(21, move), oR = 24, fps = 60;
        // a long straight run to the right at 220 a second, then a U-turn
        const owner = drive((t) => (t < 8 ? [220, 0] : [-220, 0]), fps);
        let behind = 0, side = 0, n = 0, front = 0, worst = 0;
        for (let i = 1; i <= 14 * fps; i++) {
            const t = i / fps, [ox, oy, vx] = owner(t);
            M.step(st, ox, oy, oR, 1, t, 1 / fps);
            const along = (st.x - ox) * Math.sign(vx), across = st.y - oy, d = Math.hypot(st.x - ox, across);
            if ((t > 2.5 && t < 8) || t > 11) {
                n++; if (along < 0) behind++; if (Math.abs(across) > 10) side++;
                if (along > oR) front++;
                worst = Math.max(worst, d);
            }
        }
        assert.ok(behind / n > 0.97, move + ' behind its owner ' + (100 * behind / n).toFixed(0) + '% of the run');
        assert.ok(side / n > 0.85, move + ' off to one side ' + (100 * side / n).toFixed(0) + '% of the run');
        assert.equal(front, 0, move + ' got out in front');
        // keeps up: no further back than its spot plus a bit, even at a run
        const D = oR + M.GAP + M.R;
        assert.ok(worst < D * 1.45, move + ' fell back to ' + worst.toFixed(0) + ' (spot ' + D.toFixed(0) + ')');
    }
});

test('follows: when its owner stops it potters about, wanders off to things and hurries back', async () => {
    const M = await mathMod();
    for (const move of ['orbit', 'sway', 'zip', 'guard']) {
        const oR = 24, fps = 60, D = oR + M.GAP + M.R, hi = oR + M.LEASH;
        // nothing about: a lazy loop round its owner, with noses about further out
        {
            const st = M.makeState(31, move);
            let far = 0, minD = Infinity, phases = new Set(), moved = 0, last = null;
            const angles = new Set();
            for (let i = 1; i <= 40 * fps; i++) {
                const t = i / fps;
                M.step(st, 0, 0, oR, 1, t, 1 / fps);
                const d = Math.hypot(st.x, st.y);
                if (t > 1) { far = Math.max(far, d); minD = Math.min(minD, d); phases.add(st.ex); }
                angles.add(Math.floor((Math.atan2(st.y, st.x) + Math.PI) / (Math.PI / 4)));
                if (last) moved += Math.hypot(st.x - last[0], st.y - last[1]);
                last = [st.x, st.y];
            }
            assert.ok([1, 2, 3].every(p => phases.has(p)), move + ' went off for a look and came back (' + [...phases] + ')');
            assert.ok(far > D * 1.35 && far <= hi, move + ' wandered out to ' + far.toFixed(0));
            assert.ok(angles.size >= 4, move + ' only covered ' + angles.size + '/8 of the way round');
            assert.ok(moved > 600, move + ' sat still (' + moved.toFixed(0) + ' units in 40 s)');
        }
        // a gem nearby: it goes right up to it, looks at it, and comes back
        {
            const st = M.makeState(32, move);
            const sense = { ex: NaN, ey: NaN, gx: 100, gy: -40, gr: 9 };
            let closest = Infinity, looked = 0, back = false, wasOut = false;
            for (let i = 1; i <= 30 * fps; i++) {
                const t = i / fps;
                M.step(st, 0, 0, oR, 1, t, 1 / fps, sense);
                const dg = Math.hypot(st.x - 100, st.y + 40);
                closest = Math.min(closest, dg);
                if (st.ex === 2 && st.exThing && angDiff(st.face, Math.atan2(-40 - st.y, 100 - st.x)) < 0.25) looked++;
                if (st.ex === 1 || st.ex === 2) wasOut = true;
                if (wasOut && st.ex === 0 && Math.hypot(st.x, st.y) < D * 1.3) back = true;
            }
            assert.ok(closest < 9 + M.R + 10, move + ' never got to the gem (' + closest.toFixed(0) + ')');
            assert.ok(looked > 10, move + ' never looked at the gem');
            assert.ok(back, move + ' never came back');
        }
    }
});

// ── aim ───────────────────────────────────────────────────────────────
test('aim: its own, never its owner\'s: enemies, gems, the owner, a look about with pauses', async () => {
    const M = await mathMod();
    // the maths has no owner aim to copy, and the game never hands it one
    assert.equal(M.step.length, 8, 'step(st, ox, oy, oR, size, t, dt, sense)');
    const rt = fs.readFileSync(path.join(REPO, 'public', 'client', 'sidekicks.js'), 'utf8');
    assert.ok(!/render\.f\b|e\.of\b/.test(rt), 'sidekicks.js never reads the owner\'s facing');
    assert.match(rt, /const S = senseOf\(e, ratio, px, py, hw, hh, cam\);[\s\S]{0,200}M\.step\(e\.st, e\.wx, e\.wy, e\.oR, e\.size, t, dt, S\)/);
    const fps = 60, oR = 24;
    // an owner aiming all over the place while it runs a loop: the sidekick's
    // barrels don't follow (owner aim and sidekick face don't move together)
    {
        const st = M.makeState(41, 'orbit');
        const owner = drive((t) => [160 * Math.cos(t * 0.4), 160 * Math.sin(t * 0.4)], fps);
        let same = 0, n = 0, prevF = null, prevA = null, together = 0, moves = 0;
        for (let i = 1; i <= 30 * fps; i++) {
            const t = i / fps, [ox, oy] = owner(t);
            const ownerAim = Math.sin(t * 2.3) * 2.5 + t * 0.9;
            M.step(st, ox, oy, oR, 1, t, 1 / fps);
            if (t > 1) {
                n++; if (angDiff(st.face, ownerAim) < 0.2) same++;
                if (prevF !== null) {
                    const df = st.face - prevF, da = ownerAim - prevA;
                    if (Math.abs(da) > 0.01) { moves++; if (Math.abs(df - da) < 0.01) together++; }
                }
            }
            prevF = st.face; prevA = ownerAim;
        }
        assert.ok(same / n < 0.2, 'pointed where its owner aims ' + (100 * same / n).toFixed(0) + '% of the time');
        assert.ok(together / moves < 0.05, 'turned with its owner ' + (100 * together / moves).toFixed(0) + '% of the time');
    }
    // an enemy: it watches it, smoothly, wherever it goes
    {
        const st = M.makeState(42, 'guard');
        const sense = { ex: NaN, ey: NaN, gx: NaN, gy: NaN };
        let off = 0, n = 0;
        for (let i = 1; i <= 12 * fps; i++) {
            const t = i / fps;
            sense.ex = 350 * Math.cos(t * 0.5); sense.ey = 350 * Math.sin(t * 0.5);
            M.step(st, 0, 0, oR, 1, t, 1 / fps, sense);
            if (t > 1.5) { n++; off = Math.max(off, angDiff(st.face, Math.atan2(sense.ey - st.y, sense.ex - st.x))); }
        }
        assert.ok(off < 0.12, 'kept its eye on the enemy to within ' + off.toFixed(3) + ' rad');
        assert.equal(st.look, 2);
        // far off: not its business
        sense.ex = 5000; sense.ey = 0;
        for (let i = 0; i < 30; i++) M.step(st, 0, 0, oR, 1, 12 + i / fps, 1 / fps, sense);
        assert.ok(!st.hasEnemy && st.look !== 2, 'an enemy across the map is ignored');
    }
    // nothing about, owner idle: looks round (a spread of directions), holds
    // still between looks, and glances up at its owner now and then
    for (const move of ['orbit', 'sway', 'hover']) {
        const st = M.makeState(43, move);
        let still = 0, n = 0, glances = 0;
        const dirs = new Set();
        let prev = null;
        for (let i = 1; i <= 40 * fps; i++) {
            const t = i / fps;
            M.step(st, 0, 0, oR, 1, t, 1 / fps);
            if (t < 1) continue;
            n++;
            dirs.add(Math.floor(((st.face % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI) / (Math.PI / 4)));
            if (prev !== null && Math.abs(st.face - prev) * fps < 0.05) still++;
            if (st.look === 3 && angDiff(st.face, Math.atan2(-st.y, -st.x)) < 0.3) glances++;
            prev = st.face;
        }
        assert.ok(dirs.size >= 5, move + ' only looked ' + dirs.size + '/8 ways');
        assert.ok(still / n > 0.3, move + ' never paused (' + (100 * still / n).toFixed(0) + '% still)');
        assert.ok(glances > 30, move + ' never glanced at its owner');
    }
    // a spinner spins with nothing to watch, and stops to watch an enemy
    {
        const st = M.makeState(44, 'spin');
        let spun = 0;
        for (let i = 1; i <= 6 * fps; i++) { const f0 = st.face; M.step(st, 0, 0, oR, 1, i / fps, 1 / fps); if (st.look === 6) spun += st.face - f0; }
        assert.ok(spun > 3, 'the spinner spun ' + spun.toFixed(2));
        const sense = { ex: 300, ey: 0, gx: NaN, gy: NaN };
        for (let i = 1; i <= 2 * fps; i++) M.step(st, 0, 0, oR, 1, 6 + i / fps, 1 / fps, sense);
        assert.ok(angDiff(st.face, Math.atan2(-st.y, 300 - st.x)) < 0.1, 'and watched the enemy');
    }
});

test('aim: barrels turn like a little spring (a touch of overshoot, then settle), no angle steps', async () => {
    const M = await mathMod();
    for (const fps of [30, 60, 144]) {
        const st = M.makeState(2, 'orbit');
        st.face = 0; st.w = 0;
        let peak = 0, settled = null, biggest = 0, prev = 0;
        for (let i = 1; i <= fps * 1.5; i++) {
            M.aimStep(st, 1.2, 1 / fps);
            peak = Math.max(peak, st.face);
            if (settled === null && i / fps > 0.3 && Math.abs(st.face - 1.2) < 0.02) settled = i / fps;
            biggest = Math.max(biggest, Math.abs(st.face - prev) * fps); prev = st.face;
        }
        const over = (peak - 1.2) / 1.2;
        assert.ok(over > 0.01 && over < 0.15, fps + ' fps overshoot ' + (100 * over).toFixed(1) + '%');
        assert.ok(settled !== null && settled < 0.8, fps + ' fps settled at ' + settled);
        assert.ok(biggest <= M.TURN_MAX + 1e-6, fps + ' fps turned ' + biggest.toFixed(2) + ' rad/s');
    }
    // in play, at 60 fps: at most ~a seventh of a radian a frame even mid-swing (the old sprites stepped 15 degrees)
    for (const move of ['orbit', 'spin']) {
        const st = M.makeState(2, move);
        const sense = { ex: NaN, ey: NaN, gx: NaN, gy: NaN };
        let biggest = 0, prev = null;
        for (let t = 0; t < 30; t += 1 / 60) {
            sense.ex = t % 6 < 3 ? 400 : NaN; sense.ey = -200;
            M.step(st, 0, 0, 30, 1, t, 1 / 60, sense);
            M.shotDue(st, t, Math.random);
            if (prev !== null) biggest = Math.max(biggest, Math.abs(st.face - prev));
            prev = st.face;
        }
        assert.ok(biggest < 0.15, move + ' turned ' + biggest.toFixed(3) + ' rad in one frame');
    }
    const rt = fs.readFileSync(path.join(REPO, 'public', 'client', 'sidekicks.js'), 'utf8');
    assert.ok(!/ANGLES|STEP_A/.test(rt), 'no angle table');
    assert.match(rt, /c\.rotate\(a\);\s*c\.drawImage\(cv, -w \/ 2, -w \/ 2, w, w\)/, 'one rotated blit');
});

// ── scale ─────────────────────────────────────────────────────────────
test('scale: grows a little with its owner (sqrt, 1x to 1.8x), gaps, leash and tag with it', async () => {
    const M = await mathMod();
    assert.equal(M.ownerScale(M.BASE_TANK), 1, 'a fresh tank: as it was');
    assert.equal(M.ownerScale(10), 1, 'never smaller');
    assert.ok(Math.abs(M.ownerScale(M.BASE_TANK * 2) - Math.SQRT2) < 1e-9, 'twice the size: sqrt 2');
    assert.equal(M.ownerScale(M.BASE_TANK * 10), M.GROW_MAX, 'capped at 1.8x');
    for (let s = 1; s < 12; s *= 1.1) assert.ok(M.ownerScale(M.BASE_TANK * s * 1.1) >= M.ownerScale(M.BASE_TANK * s), 'never shrinks as its owner grows');
    // at every owner size: clear of the hull by the scaled margin, inside the
    // scaled leash, and its spot sits further out the bigger the owner
    let lastSpot = 0;
    for (const oR of [24, 36, 48, 72, 100, 150, 220]) {
        const st = M.makeState(51, 'orbit'), sc = M.ownerScale(oR), r = M.R * sc;
        let near = Infinity, far = 0, sum = 0, n = 0;
        const owner = drive((t) => (t % 10 < 6 ? [150 * Math.cos(t), 150 * Math.sin(t * 0.7)] : [0, 0]), 60);
        for (let i = 1; i <= 20 * 60; i++) {
            const t = i / 60, [ox, oy] = owner(t);
            M.step(st, ox, oy, oR, 1, t, 1 / 60);
            const d = Math.hypot(st.x - ox, st.y - oy);
            near = Math.min(near, d); far = Math.max(far, d); sum += d - oR; n++;
        }
        assert.equal(st.sc, sc);
        assert.ok(near - oR - r >= M.CLEAR * sc - 1e-6, 'owner ' + oR + ': gap ' + (near - oR - r).toFixed(1));
        assert.ok(far - oR <= M.LEASH * sc + 1e-6, 'owner ' + oR + ': leash ' + (far - oR).toFixed(1));
        assert.ok(sum / n > lastSpot, 'owner ' + oR + ': further out from the edge than a smaller one');
        lastSpot = sum / n;
    }
    // the game draws it, its shots and its tag at that scale; sprites come
    // from rungs at most ~7% apart and are only ever drawn smaller
    const rt = fs.readFileSync(path.join(REPO, 'public', 'client', 'sidekicks.js'), 'utf8');
    assert.match(rt, /const rpx = M\.R \* e\.size \* s\.sc \* ratio/);
    assert.match(rt, /r = M\.R \* e\.size \* st\.sc/, 'shots from the scaled muzzle');
    assert.match(rt, /LABEL_WORLD \* Math\.sqrt\(sc \|\| 1\)/, 'the tag grows a little (sqrt)');
    assert.match(rt, /RUNGS\[i\] >= rpx/, 'baked at the rung above, drawn smaller');
    assert.match(rt, /r = Math\.max\(r \+ 1, Math\.round\(r \* 1\.07\)\)/);
});

// ── smooth ────────────────────────────────────────────────────────────
test('smooth: the same at 30, 60 and 144 fps, no stepping, on the frame clock', async () => {
    const M = await mathMod();
    // tank-like owner: a curving run, a stop (it potters), a run off the other way
    const want = (t) => (t < 8 ? [200 * Math.cos(t * 0.5), 200 * Math.sin(t * 0.5)] : t < 20 ? [0, 0] : [-180, 90]);
    const run = (fps, move) => {
        const st = M.makeState(4, move), owner = drive(want, fps);
        const sense = { ex: NaN, ey: NaN, gx: NaN, gy: NaN, gr: 10 };
        const at = new Map();
        let prev = null, pv = null, acc = 0, hop = 0, turn = 0, ph = 0, pf = 0;
        for (let i = 1; i <= 30 * fps; i++) {
            const t = i / fps, [ox, oy] = owner(t);
            sense.gx = t > 9 ? ox + 65 : NaN; sense.gy = oy + 120;
            M.step(st, ox, oy, 30, 1, t, 1 / fps, sense);
            // every sixth of a second, to compare frame rates
            const k = Math.round(t * 6);
            if (Math.abs(t * 6 - k) < 1e-6) at.set(k, [st.x - ox, st.y - oy, st.face]);
            if (prev) {
                const v = [(st.x - prev[0]) * fps, (st.y - prev[1]) * fps];
                if (pv && t > 0.5) acc = Math.max(acc, Math.hypot(v[0] - pv[0], v[1] - pv[1]) * fps);
                pv = v;
                if (t > 0.5) { hop = Math.max(hop, Math.abs(st.hop - ph) * fps); turn = Math.max(turn, Math.abs(st.face - pf) * fps); }
            }
            prev = [st.x, st.y]; ph = st.hop; pf = st.face;
        }
        return { at, acc, hop, turn };
    };
    for (const move of ['orbit', 'zip', 'bounce', 'sway']) {
        const [a30, a60, a144] = [30, 60, 144].map(f => run(f, move));
        // the same path on the run (decisions later on can fall a frame apart)
        for (const [o, f, most] of [[a30, 30, 2.5], [a60, 60, 1.2]]) {
            let worst = 0, faceWorst = 0;
            for (const [k, p] of a144.at) {
                if (k > 7 * 6) break;
                const q = o.at.get(k);
                worst = Math.max(worst, Math.hypot(p[0] - q[0], p[1] - q[1]));
                faceWorst = Math.max(faceWorst, angDiff(p[2], q[2]));
            }
            // (a couple of units is under a pixel at 30 fps zoomed out)
            assert.ok(worst < most, move + ': ' + f + ' vs 144 fps paths ' + worst.toFixed(2) + ' apart');
            // its mind is made up on frames, so a look can start a frame later:
            // never more than one frame's turn apart
            assert.ok(faceWorst < M.TURN_MAX / f + 0.05, move + ': ' + f + ' vs 144 fps aim ' + faceWorst.toFixed(3) + ' apart');
        }
        // no stepping: its acceleration, bob and turn rate are bounded and
        // don't grow with the frame rate (a step shows up as a spike that
        // gets taller the shorter the frame)
        for (const [f, r] of [[30, a30], [60, a60], [144, a144]]) {
            assert.ok(r.acc < 2600, move + ' at ' + f + ' fps: ' + r.acc.toFixed(0) + ' u/s²');
            assert.ok(r.turn <= M.TURN_MAX + 1e-6, move + ' at ' + f + ' fps turned ' + r.turn.toFixed(2) + ' rad/s');
        }
        assert.ok(a144.acc < a30.acc * 1.3, move + ': acceleration ' + a30.acc.toFixed(0) + ' -> ' + a144.acc.toFixed(0) + ' u/s² from 30 to 144 fps');
        assert.ok(a144.hop < a30.hop * 1.3 + 1, move + ': bob ' + a30.hop.toFixed(0) + ' -> ' + a144.hop.toFixed(0) + ' u/s');
    }
    // the game follows the owner where it is drawn (renderx / rendery for
    // your own tank, the camera turned back into world units), on the frame
    // time app.js drew the tanks with, at sub-pixel spots
    const app = fs.readFileSync(path.join(REPO, 'public', 'client', 'app.js'), 'utf8');
    assert.match(app, /sidekicks\.draw\(ctx\[1\], ratio, px, py, tick, gui\.playerid\)/);
    const rt = fs.readFileSync(path.join(REPO, 'public', 'client', 'sidekicks.js'), 'utf8');
    assert.match(rt, /e\.wx = \(e\.ox - hw \+ px\) \/ ratio/);
    assert.match(rt, /const t = advance\(tick === tick && tick != null \? tick : now\)/);
    assert.ok(!/Math\.round\(sx|Math\.round\(e\.sx|Math\.round\(top/.test(rt), 'no whole-pixel snapping against the owner');
    // what it watches is followed where it is drawn this frame, not at network ticks
    assert.match(rt, /S\.ex = cam \? \(en\._sx - hw \+ px\) \/ ratio/);
});

// ── personality ───────────────────────────────────────────────────────
test('personality: two owners\' sidekicks are never in step; the same owner is the same everywhere', async () => {
    const M = await mathMod();
    const run = (seed, move) => {
        const st = M.makeState(seed, move), fps = 60, out = [];
        const owner = drive((t) => (t % 12 < 7 ? [170 * Math.cos(t * 0.3), 170 * Math.sin(t * 0.3)] : [0, 0]), fps);
        for (let i = 1; i <= 36 * fps; i++) {
            const t = i / fps, [ox, oy] = owner(t);
            M.step(st, ox, oy, 24, 1, t, 1 / fps);
            if (i % 6 === 0) out.push([st.x - ox, st.y - oy, st.face, st.hop]);
        }
        return out;
    };
    for (const move of ['orbit', 'zip', 'bounce', 'guard']) {
        const a = run(1001, move), b = run(2002, move), a2 = run(1001, move);
        assert.deepEqual(a2, a, move + ': the same owner id plays out the same on every client');
        let apart = 0, face = 0, close = 0;
        for (let i = 0; i < a.length; i++) {
            const d = Math.hypot(a[i][0] - b[i][0], a[i][1] - b[i][1]);
            apart += d; face += angDiff(a[i][2], b[i][2]);
            if (d < 6 && angDiff(a[i][2], b[i][2]) < 0.15) close++;
        }
        assert.ok(apart / a.length > 25, move + ': two owners\' sidekicks only ' + (apart / a.length).toFixed(1) + ' apart on average');
        assert.ok(face / a.length > 0.6, move + ': looking the same way (' + (face / a.length).toFixed(2) + ' rad apart on average)');
        assert.ok(close / a.length < 0.05, move + ': in step ' + (100 * close / a.length).toFixed(0) + '% of the time');
    }
});

test('personality: a happy bounce when its owner banks, kills or picks something up', async () => {
    const M = await mathMod();
    const st = M.makeState(61, 'guard');
    let t = 0;
    const tick = (n) => { let hi = 0; for (let i = 0; i < n; i++) { t += 1 / 60; M.step(st, 0, 0, 24, 1, t, 1 / 60); hi = Math.max(hi, st.hop); } return hi; };
    const calm = tick(240);
    M.cheer(st, t, 1);
    let looked = 0, hop = 0, prev = st.hop, jump = 0;
    for (let i = 0; i < 40; i++) {
        t += 1 / 60; M.step(st, 0, 0, 24, 1, t, 1 / 60);
        hop = Math.max(hop, st.hop); jump = Math.max(jump, Math.abs(st.hop - prev)); prev = st.hop;
        if (angDiff(st.face, Math.atan2(-st.y, -st.x)) < 0.3) looked++;
    }
    assert.ok(hop > calm + 5, 'bounced up to ' + hop.toFixed(1) + ' (calm ' + calm.toFixed(1) + ')');
    assert.ok(jump < 2, 'smoothly (' + jump.toFixed(2) + ' a frame)');
    assert.ok(looked > 5, 'and looked up at its owner');
    tick(30);
    assert.ok(tick(120) <= calm + 0.5, 'then calms down');
    // the game cheers on banking, kills and pickups (your own), and for any
    // owner next to a chest cracking or a tank going down
    const so = fs.readFileSync(path.join(REPO, 'public', 'client', 'socketinit.js'), 'utf8');
    assert.match(so, /if \(!m\[4\]\) try \{ sidekicks\.cheer\(gui\.playerid, 1\)/, 'banked');
    assert.match(so, /sidekicks\.cheer\(gui\.playerid, 0\.45\)/, 'picked up');
    assert.match(so, /SIDEKICK_CHEERS\[m\[0\]\]/, 'kills and the like');
    assert.match(so, /sidekicks\.cheerNear\(fx\.x, fx\.y/, 'next to it');
    assert.match(so, /const SIDEKICK_CHEERS = \{ kill: 1,/);
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

// ── digging (sidekickDig.js) ──────────────────────────────────────────
const dig = require(path.join(SERVER, 'game', 'terrain', 'sidekickDig.js'));
const gemsMod = require(path.join(SERVER, 'game', 'terrain', 'gems.js'));
const mkRock = (x, y, ore = 0, hp = 1000) => ({ wx: x, wy: y, alive: true, growing: false, ore, health: hp, maxHealth: hp });
function fakeTg(rocks) {
    const calls = [];
    return {
        calls, rocks, baseRockHealth: 100, searches: 0,
        nearestRock(x, y, maxR) {
            this.searches++;
            let best = maxR * maxR, hit = null;
            for (const r of rocks) { if (!r.alive) continue; const q = (r.wx - x) ** 2 + (r.wy - y) ** 2; if (q < best) { best = q; hit = r; } }
            return hit;
        },
        damageRock(rock, dmg, x, y, grind, who) {
            calls.push({ rock, dmg, who });
            rock.health -= dmg;
            if (rock.health <= 0) { rock.health = 0; rock.alive = false; return true; }
            return false;
        },
    };
}
// gems: spy on the owner's payout (no gem entities in a unit test)
function spyGems() {
    const real = { chipHit: gemsMod.chipHit, spawnOreBurst: gemsMod.spawnOreBurst };
    const said = { chips: [], bursts: [] };
    gemsMod.chipHit = (rock, who, dmg) => { said.chips.push({ rock, who, dmg }); return 0; };
    gemsMod.spawnOreBurst = (rock, who) => { said.bursts.push({ rock, who }); };
    said.restore = () => Object.assign(gemsMod, real);
    return said;
}
function digOwner(nid, extra = {}) { return owner({ facing: 0, size: 24, sidekick: { nid, skin: 0, ns: 0, name: '', color: '' }, ...extra }); }
// the t rows of the change packets (not a socket's first whole table)
const T = (s) => SK(s).filter(p => p.t && !p.f).map(p => p.t);

test('digging: damage by rarity, Buddy barely scratches, the legendaries close to (under) a bare Pounder shot', () => {
    const { combineStats } = require(path.join(SERVER, 'lib', 'definitions', 'facilitators.js'));
    const g = require(path.join(SERVER, 'lib', 'definitions', 'gunvals.js'));
    const mining = require(path.join(SERVER, 'game', 'terrain', 'mining.js'));
    // a level-45 Pounder bullet, no stat points (skillFactor mining.SHOT_BARE, 0.54 since Oct 5 2026), in baseRockHealth units
    const pounder = 0.1 * mining.digPower(combineStats([g.basic, g.pounder])) * mining.SHOT_BARE;
    assert.ok(Math.abs(pounder - dig.POUNDER_REF) < 1e-9, 'POUNDER_REF ' + dig.POUNDER_REF + ' vs ' + pounder);
    const kicks = C.ITEMS.filter(it => it.cat === 'sidekick' && !it.retired);
    const share = (id) => C.sidekickDigShare(C.byId(id));
    assert.ok(Math.abs(share(C.BASIC_SIDEKICK_ID) - 0.10) < 1e-9, 'Buddy ' + share(C.BASIC_SIDEKICK_ID));
    for (const id of ['sd_jack', 'sd_closer']) {
        assert.ok(share(id) >= 0.7 && share(id) < 0.8, id + ' ' + share(id));
        assert.ok(dig.damageFor(C.byId(id), 100) < pounder * 100, id + ' under a Pounder shot');
    }
    // rarities never overlap, and inside one the dearer one digs at least as hard
    const order = C.RARITY_ORDER;
    for (let i = 1; i < order.length; i++) {
        const lo = Math.max(...kicks.filter(k => k.rarity === order[i - 1]).map(k => C.sidekickDigShare(k)));
        const hi = Math.min(...kicks.filter(k => k.rarity === order[i]).map(k => C.sidekickDigShare(k)));
        assert.ok(lo < hi, order[i - 1] + ' ' + lo + ' < ' + order[i] + ' ' + hi);
    }
    for (const a of kicks) for (const b of kicks) if (a.rarity === b.rarity && a.price < b.price) assert.ok(C.sidekickDigShare(a) <= C.sidekickDigShare(b));
    assert.equal(C.sidekickDigShare(C.byId('sds_stripes')), 0, 'a skin digs nothing');
    assert.equal(dig.damageFor({ nid: 217 }, 100), 100 * dig.POUNDER_REF * share('sd_jack'));
});

test('digging: always shoots the rock in front of its owner (else the nearest), a shot a second, told to the clients on change only', () => {
    sidekicks.reset();
    const front = mkRock(150, 0), behind = mkRock(-110, 0), far = mkRock(5000, 0);
    const tg = fakeTg([front, behind, far]);
    global.gameManager = { terrainGrid: tg };
    try {
        const o = digOwner(217), viewer = sock();
        for (let i = 0; i < 100; i++) tick([o], [o.socket, viewer]);   // ten seconds
        const t = T(viewer).flat();
        assert.deepEqual(t[0], [o.id, 150, 0], 'the rock in front, not the nearer one behind');
        assert.equal(T(viewer).length, 1, 'one t packet while it keeps the same rock');
        const shots = tg.calls.length;
        assert.ok(shots >= 9 && shots <= 10, 'a shot a second: ' + shots);
        assert.ok(tg.calls.every(c => c.rock === front && c.who === null), 'rock only, and no owner on the rock (no rock credit)');
        assert.ok(tg.searches <= 2 * 26, 'one search per ' + dig.SEARCH_MS + ' ms at most: ' + tg.searches);
        // the owner turns round: the one behind is in front now
        o.facing = Math.PI;
        o._rockHitAt = clock;
        for (let i = 0; i < 10; i++) tick([o], [o.socket, viewer]);
        assert.deepEqual(T(viewer).pop()[0], [o.id, -110, 0], 'it follows what its owner is mining');
        // nothing in range: it stops (and says so), never shoots the far one
        front.alive = false; behind.alive = false;
        const n = tg.calls.length;
        for (let i = 0; i < 30; i++) tick([o], [o.socket, viewer]);
        assert.deepEqual(T(viewer).pop()[0], [o.id], 'no rock: nothing to aim at');
        assert.ok(tg.calls.length <= n + 1 && tg.calls.every(c => c.rock !== far), 'nothing out of range');
        // hidden (smoke): no shots
        front.alive = true; front.health = 1e9;
        o.smokeHidden = true;
        const m = tg.calls.length;
        for (let i = 0; i < 30; i++) tick([o], [o.socket, viewer]);
        assert.ok(tg.calls.length <= m + 1, 'hidden owners\' sidekicks hold fire');
        // a new socket gets the whole table with the targets
        o.smokeHidden = false;
        for (let i = 0; i < 10; i++) tick([o], [o.socket, viewer]);
        const late = sock();
        tick([o], [late]);
        assert.deepEqual(SK(late)[0].t, [[o.id, 150, 0]]);
    } finally { delete global.gameManager; sidekicks.reset(); }
});

test('digging: rock only (players, bosses and chests in the way are never touched), gems to the owner, no rock-count credit', () => {
    sidekicks.reset();
    const ore = mkRock(140, 0, 2, 40), plain = mkRock(140, 40, 0, 1e9);
    const tg = fakeTg([ore, plain]);
    global.gameManager = { terrainGrid: tg };
    const spy = spyGems();
    const before = global.entities.size;
    try {
        const o = digOwner(228);
        // an enemy tank, a boss and a chest sitting on the line of fire
        const bystanders = [{ id: 1, x: 70, y: 0, health: { amount: 100 } }, { id: 2, x: 100, y: 0, isBoss: true, health: { amount: 1e4 } }, { id: 3, x: 120, y: 0, chest: true, health: { amount: 50 } }];
        for (let i = 0; i < 80; i++) tick([o, ...bystanders], [o.socket]);
        assert.ok(bystanders.every(b => b.health.amount === (b.isBoss ? 1e4 : b.chest ? 50 : 100)), 'nobody else lost anything');
        assert.equal(global.entities.size, before, 'no bullet entity, ever');
        assert.equal(ore.alive, false, 'it broke the ore rock');
        const per = dig.damageFor({ nid: 228 }, tg.baseRockHealth);
        const oreHit = tg.calls.find(c => c.rock === ore), plainHit = tg.calls.find(c => c.rock === plain);
        assert.ok(Math.abs(oreHit.dmg - per) < 1e-9, 'ore takes the shot as is');
        assert.ok(plainHit && Math.abs(plainHit.dmg - per * gemsMod.PLAIN_ROCK_MULT) < 1e-9, 'plain rock takes PLAIN_ROCK_MULT, like any shot');
        assert.ok(spy.chips.length > 0 && spy.chips.every(c => c.who === o), 'ore chips go to the owner');
        assert.deepEqual(spy.bursts.map(b => [b.rock, b.who]), [[ore, o]], 'the break payout flies to the owner');
        assert.equal(o.rocksMined, undefined, 'no rocksMined (pity copper, achievements)');
        assert.equal(o.gemsMined, undefined, 'no gemsMined');
        assert.ok(tg.calls.every(c => c.who === null), 'damageRock gets no owner: no rock achievement credit');
        // a Buddy digs a seventh of that
        assert.ok(dig.damageFor({ nid: 201 }, 100) < dig.damageFor({ nid: 228 }, 100) / 7 + 1e-9);
    } finally { spy.restore(); delete global.gameManager; sidekicks.reset(); }
});

test('digging: cheap: one shot in the air each, a per-tick cap across the raid, ROYALE_SIDEKICK_DIG=0 turns it off', () => {
    sidekicks.reset();
    const rocks = [];
    for (let i = 0; i < 60; i++) rocks.push(mkRock(i * 400 + 150, 0, 0, 1e12));
    const tg = fakeTg(rocks);
    global.gameManager = { terrainGrid: tg };
    try {
        const many = [];
        for (let i = 0; i < 60; i++) many.push(digOwner(201, { x: i * 400 }));
        let worst = 0;
        for (let i = 0; i < 40; i++) { const n = tg.calls.length; tick(many, []); worst = Math.max(worst, tg.calls.length - n); }
        assert.ok(worst <= dig.MAX_FIRES, 'at most ' + dig.MAX_FIRES + ' landings a tick: ' + worst);
        assert.ok(tg.calls.length >= 60 * 2, 'they all still dig: ' + tg.calls.length);
    } finally { delete global.gameManager; sidekicks.reset(); }
    const r = spawnSync(process.execPath, ['--no-warnings', __filename, '--dig-off'], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), { on: false, hits: 0, changed: 0 });
    assert.match(fs.readFileSync(path.join(SERVER, '.env.example'), 'utf8'), /^ROYALE_SIDEKICK_DIG=1$/m);
});

test('digging: the client aims at the rock and fires a shot a second that flies all the way there', async () => {
    const M = await mathMod();
    const st = M.makeState(11, 'spin');
    const sense = { ex: 300, ey: 120, gx: NaN, gy: NaN };
    st.dig = true;
    let last = -1, gaps = [], off = 0;
    for (let t = 0; t < 20; t += 1 / 60) {
        M.step(st, 0, 0, 24, 1, t, 1 / 60, sense);
        const a = M.shotDue(st, t, Math.random);
        if (a === a) { if (last >= 0) gaps.push(t - last); last = t; if (t > 2) off = Math.max(off, angDiff(a, Math.atan2(sense.ey - st.y, sense.ex - st.x))); }
    }
    assert.ok(gaps.length >= 16 && gaps.every(g => Math.abs(g - M.DIG_GAP) < 0.03), 'gaps ' + gaps.map(g => g.toFixed(2)));
    assert.ok(off < 0.15, 'aimed at the rock, ' + off.toFixed(3) + ' rad off');
    assert.equal(M.DIG_GAP * 1000, dig.FIRE_MS);
    assert.equal(M.DIG_SPEED, dig.SPEED);
    assert.ok(Math.abs(M.digLife(300) - 0.5) < 1e-9 && M.digLife(5000) === M.DIG_LIFE_MAX);
    assert.equal(M.facesRock(0, 0, 0, 100, 10), true);
    assert.equal(M.facesRock(Math.PI, 0, 0, 100, 0), false, 'a back barrel just pops');
    const client = fs.readFileSync(path.join(REPO, 'public', 'client', 'sidekicks.js'), 'utf8');
    assert.match(client, /Array\.isArray\(d\.t\)/, 'it reads the t rows');
    assert.match(client, /if \(e\.digOn\) \{ S\.ex = e\.dx; S\.ey = e\.dy; \}/, 'the rock is what it watches');
    // the shop and the Locker say it helps you mine
    assert.equal(C.SIDEKICK_DIG_LINE, 'Helps you mine: rock only.');
    for (const f of ['shop.js', 'locker.js']) assert.match(fs.readFileSync(path.join(REPO, 'public', 'client', 'account', f), 'utf8'), /SIDEKICK_DIG_LINE/);
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
test('dig: a shot hits the first rock on its line, not a rock behind it', () => {
    const near = { alive: true, worldCx: 200, worldCy: 1 }, far = { alive: true, worldCx: 400, worldCy: 1 };
    const tg = { rockHitByCircle: (x, y) => Math.abs(y) < 40 ? (Math.abs(x - 200) < 40 ? near : Math.abs(x - 400) < 40 ? far : null) : null };
    const b = { x: 0, y: 0, size: 20 };
    assert.equal(dig.firstOnLine(tg, b, far), near, 'the rock in the way takes it');
    assert.equal(dig.firstOnLine(tg, b, near), near, 'a clear line keeps the target');
});

// Regression (Oct 6 2026, "sidekicks aren't shooting"): the client dropped
// every sidekick shot under Low effects / Fewer Effects / lowFx, and the auto
// low-end trim's first rung is Low effects, so on most machines they never
// fired. The real runtime, on a recording canvas, must fire at every level.
test('shots: fired and drawn at every effects level (Low, Fewer Effects, the auto trim)', () => {
    const run = (lvl) => {
        const r = spawnSync(process.execPath, ['--no-warnings', __filename, '--client-shots', lvl], { encoding: 'utf8' });
        assert.equal(r.status, 0, r.stderr);
        return JSON.parse(r.stdout);
    };
    for (const lvl of ['normal', 'low']) {
        const o = run(lvl);
        assert.equal(o.rows, 1, lvl + ': the row is there');
        assert.deepEqual(o.dig, { x: 260, y: 40 }, lvl + ': it knows its rock');
        // a shot a second while mining: ~5 in 6 s, each drawn for several frames
        assert.ok(o.arcs >= 20, lvl + ': shots drawn, ' + o.arcs + ' arc calls');
    }
    const rt = fs.readFileSync(path.join(REPO, 'public', 'client', 'sidekicks.js'), 'utf8');
    assert.ok(!/lowFx|fxLevel|fewerEffects/.test(rt), 'no effects gate on its shots');
});

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
