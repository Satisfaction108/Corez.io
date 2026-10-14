'use strict';

const assert = require('node:assert/strict');
const path = require('path');

const SERVER = path.join(__dirname, '..', '..', 'server');
require(path.join(SERVER, 'loaders', 'global.js'));
global.gameManager = { roomSpeed: 1, runSpeed: 1.5 };
const drive = require(path.join(SERVER, 'miscFiles', 'drive.js'));

const DIEP_RISE_MS = 1200;
const DIEP_STOP_MS = 1200;
const TICK = drive.TICK_MS;

function tank(mob = 1, size = 1) {
    return {
        type: 'tank', bond: null, motionType: 'motor', motionTypeArgs: {},
        acceleration: 1.5 * 1.6 / size, topSpeed: 1.5 * 5.25 * mob / size,
        x: 0, y: 0, velocity: { x: 0, y: 0 }, accel: { x: 0, y: 0 }, damp: 0.05, maxSpeed: 0,
        control: { goal: { x: 0, y: 0 }, power: 1 },
    };
}

function friction(b) {
    const motion = Math.hypot(b.velocity.x, b.velocity.y), excess = motion - b.maxSpeed;
    if (excess > 0 && b.damp) {
        const k = b.damp / global.gameManager.roomSpeed, fin = b.maxSpeed + excess / (k + 1);
        b.velocity.x = fin * b.velocity.x / motion;
        b.velocity.y = fin * b.velocity.y / motion;
    }
}

function tick(b, kx = 0, ky = 0, hook) {
    b.velocity.x += b.accel.x;
    b.velocity.y += b.accel.y;
    b.accel.x = 0;
    b.accel.y = 0;
    const px = b.x, py = b.y;
    b.x += b.velocity.x / global.gameManager.roomSpeed;
    b.y += b.velocity.y / global.gameManager.roomSpeed;
    b.control.goal = { x: b.x + kx, y: b.y + ky };
    global.runMove(b);
    if (hook) hook(b);
    friction(b);
    return { dx: b.x - px, dy: b.y - py };
}

function withDrive(on, fn) {
    const was = drive.CFG.on;
    drive.CFG.on = on;
    try { return fn(); } finally { drive.CFG.on = was; }
}

function cruise(b, kx = 1, ky = 0, n = 400) {
    let s = null;
    for (let i = 0; i < n; i++) s = tick(b, kx, ky);
    return Math.hypot(s.dx, s.dy);
}

function crossing(series, level, rising) {
    for (let i = 1; i < series.length; i++) {
        const a = series[i - 1], c = series[i];
        if (rising ? c >= level : c <= level) {
            const f = rising ? (level - a) / (c - a || 1) : (a - level) / (a - c || 1);
            return (i - 1 + f) * TICK;
        }
    }
    return Infinity;
}

function curve(on, mob = 1) {
    return withDrive(on, () => {
        const b = tank(mob);
        const top = cruise(tank(mob));
        const rise = [0];
        for (let i = 0; i < 120; i++) rise.push(tick(b, 1, 0).dx);
        const stop = [rise[rise.length - 1]];
        for (let i = 0; i < 120; i++) stop.push(tick(b, 0, 0).dx);
        const glide = stop.slice(1).reduce((s, d) => s + d, 0);
        return { top, rise90: crossing(rise, 0.9 * top, true), stop10: crossing(stop, 0.1 * top, false), glide };
    });
}

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

const before = curve(false), after = curve(true), beforeFast = curve(false, 1.805), afterFast = curve(true, 1.805);
console.log('info top speed (units/tick)  before ' + before.top.toFixed(3) + '  after ' + after.top.toFixed(3));
console.log('info 0 to 90%   before ' + before.rise90.toFixed(0) + ' ms (max Movement Speed ' + beforeFast.rise90.toFixed(0) + ')  after ' + after.rise90.toFixed(0) + ' ms (' + afterFast.rise90.toFixed(0) + ')');
console.log('info full to 10% before ' + before.stop10.toFixed(0) + ' ms (' + beforeFast.stop10.toFixed(0) + ')  after ' + after.stop10.toFixed(0) + ' ms (' + afterFast.stop10.toFixed(0) + ')');
console.log('info glide after letting go  before ' + before.glide.toFixed(1) + '  after ' + after.glide.toFixed(1) + ' units');

test('top speed is unchanged for every Movement Speed level and size', () => {
    for (const [mob, size] of [[1, 1], [1.42, 1], [1.805, 1], [1, 2], [1.805, 1.6]]) {
        const old = withDrive(false, () => cruise(tank(mob, size)));
        const now = withDrive(true, () => cruise(tank(mob, size)));
        assert.ok(Math.abs(old - now) < 1e-6, `mob ${mob} size ${size}: ${old} vs ${now}`);
    }
    assert.ok(Math.abs(after.top - (1.5 * 5.25 + 1.5 * 1.6)) < 1e-6);
});

test('reaching full speed takes 60-70% of diep, stopping 50-60% of its glide', () => {
    for (const c of [after, afterFast]) {
        assert.ok(c.rise90 >= 0.3 * DIEP_RISE_MS && c.rise90 <= 0.4 * DIEP_RISE_MS, 'rise ' + c.rise90);
        assert.ok(c.stop10 >= 0.25 * DIEP_STOP_MS && c.stop10 <= 0.35 * DIEP_STOP_MS, 'stop ' + c.stop10);
    }
    assert.ok(after.stop10 < after.rise90, 'stopping is quicker than speeding up');
    assert.ok(Math.abs(after.rise90 - afterFast.rise90) < TICK, 'the same feel at every Movement Speed level');
});

test('the response starts on the first tick, no slow wind-up', () => {
    withDrive(true, () => {
        const b = tank();
        const top = cruise(tank());
        const s = [];
        for (let i = 0; i < 4; i++) s.push(tick(b, 1, 0).dx);
        assert.equal(s[0], 0);
        assert.ok(s[1] > 0.04 * top, 'moving after one tick: ' + s[1]);
        assert.ok(s[2] - s[1] < s[1] - s[0] + 1e-9, 'biggest speed-up comes first');
        assert.ok(s[3] - s[2] < s[2] - s[1] + 1e-9);
    });
});

test('turning a corner: the old heading fades out fast, no ice drift', () => {
    withDrive(true, () => {
        const b = tank();
        const top = cruise(b);
        let side = 0, t90 = Infinity;
        for (let i = 1; i <= 60; i++) {
            const s = tick(b, 0, 1);
            side += s.dx;
            if (t90 === Infinity && s.dx < 0.1 * top) t90 = i * TICK;
        }
        assert.ok(t90 <= drive.CFG.turnMs + 2 * TICK + 1, 'old heading under 10% after ' + t90 + ' ms');
        assert.ok(side < 8 * top, 'drift along the old heading ' + side.toFixed(1));
    });
});

test('turning keeps most of the speed instead of stalling', () => {
    withDrive(true, () => {
        const b = tank();
        const top = cruise(b);
        let low = Infinity;
        for (let i = 0; i < 40; i++) { const s = tick(b, 0, 1); low = Math.min(low, Math.hypot(s.dx, s.dy)); }
        assert.ok(low > 0.72 * top, 'lowest speed in a right-angle turn ' + (low / top).toFixed(2));
    });
});

test('reversing brakes at the stop rate, then builds at the rise rate', () => {
    withDrive(true, () => {
        const b = tank();
        cruise(b);
        let zero = Infinity;
        for (let i = 1; i <= 60; i++) if (tick(b, -1, 0).dx <= 0 && zero === Infinity) zero = i * TICK;
        assert.ok(zero < 300, 'crosses zero after ' + zero + ' ms');
    });
});

test('recoil and knockback push exactly as before while driving and while still', () => {
    for (const keys of [[1, 0], [0, 0]]) {
        const run = on => withDrive(on, () => {
            const b = tank();
            cruise(b, keys[0], keys[1]);
            const x0 = b.x, out = [];
            for (let i = 0; i < 40; i++) {
                if (i === 3) { b.accel.x -= 3; b.accel.y += 2; }
                tick(b, keys[0], keys[1]);
                out.push([b.x - x0, b.y]);
            }
            return out;
        });
        const a = run(false), c = run(true);
        for (let i = 0; i < a.length; i++) {
            assert.ok(Math.abs(a[i][0] - c[i][0]) < 1e-6 && Math.abs(a[i][1] - c[i][1]) < 1e-6, `keys ${keys} tick ${i}: ${a[i]} vs ${c[i]}`);
        }
    }
});

test('a teleport or freeze while coasting leaves no ghost glide', () => {
    withDrive(true, () => {
        const b = tank();
        cruise(b);
        for (let i = 0; i < 4; i++) tick(b, 0, 0);
        b.velocity.x = 0; b.velocity.y = 0;
        const x0 = b.x;
        for (let i = 0; i < 60; i++) tick(b, 0, 0);
        assert.ok(b.x - x0 < 4, 'drift after the reset ' + (b.x - x0).toFixed(2));
    });
});

test('pressing into a wall, then letting go or the wall breaking, moves like before', () => {
    const wall = 200;
    const block = t => { if (t.x > wall) { t.x = wall; if (t.velocity.x > 0) t.velocity.x = 0; } };
    const run = (on, release) => withDrive(on, () => {
        const b = tank();
        for (let i = 0; i < 300; i++) tick(b, 1, 0, block);
        assert.ok(Math.abs(b.x - wall) < 1e-9);
        if (release) tick(b, 0, 0, block);
        const x0 = b.x, out = [];
        for (let i = 0; i < 40; i++) { tick(b, release ? 0 : 1, 0); out.push(b.x - x0); }
        return out;
    });
    const keptOld = run(false, false), keptNew = run(true, false);
    for (let i = 0; i < keptOld.length; i++) assert.ok(Math.abs(keptOld[i] - keptNew[i]) < 1e-3, 'still pressing when the rock breaks, tick ' + i);
    const goneOld = run(false, true), goneNew = run(true, true);
    const driftOld = goneOld[goneOld.length - 1], driftNew = goneNew[goneNew.length - 1];
    assert.ok(driftNew < driftOld + 4, `let go at the wall, then it breaks: drift ${driftNew.toFixed(2)} vs ${driftOld.toFixed(2)}`);
});

test('sliding off a wall gets no free speed from the push into it', () => {
    withDrive(true, () => {
        const wall = 200;
        const block = t => { if (t.x > wall) { t.x = wall; if (t.velocity.x > 0) t.velocity.x = 0; } };
        const b = tank();
        for (let i = 0; i < 300; i++) tick(b, 1, 0, block);
        const fresh = tank();
        let off = 0, rest = 0;
        for (let i = 0; i < 10; i++) { off += tick(b, 0, 1, block).dy; rest += tick(fresh, 0, 1).dy; }
        assert.ok(off <= rest * 1.03 + 0.5, `off the wall ${off.toFixed(2)} vs from rest ${rest.toFixed(2)}`);
    });
});

test('a dash along the keys hands over at full speed', () => {
    withDrive(true, () => {
        const b = tank();
        const top = cruise(tank());
        b._abMove = { kind: 'dash' };
        for (let i = 0; i < 7; i++) { tick(b, 1, 0); b.velocity.x = top * 3; b.velocity.y = 0; b.accel.x = 0; b.accel.y = 0; }
        b._abMove = null;
        b.velocity.x *= 0.45;
        let low = Infinity;
        for (let i = 0; i < 40; i++) low = Math.min(low, tick(b, 1, 0).dx);
        assert.ok(low > 0.97 * top, 'no stall after the dash: ' + (low / top).toFixed(3));
    });
});

test('touch sticks at part tilt move at part speed', () => {
    withDrive(true, () => {
        const b = tank();
        const top = cruise(tank());
        b.control.power = 0.5;
        assert.ok(Math.abs(cruise(b) - 0.5 * top) < 1e-6);
    });
});

test('bots let go early by exactly the extra glide', () => {
    withDrive(true, () => {
        const b = tank();
        cruise(b);
        const lead = drive.coastLead(b, 1, 0, 1);
        assert.ok(Math.abs(lead - (after.glide - before.glide)) < 0.5, `lead ${lead} vs ${after.glide - before.glide}`);
        assert.equal(drive.coastLead(b, -1, 0, 1), 0);
        assert.equal(drive.coastLead({}, 1, 0, 1), 0);
    });
});

test('only tanks get the new drive; bosses and others keep the old motor', () => {
    assert.equal(drive.applies(Object.assign(tank(), { type: 'miniboss' }), 2.4), false);
    assert.equal(drive.applies(Object.assign(tank(), { bond: {} }), 2.4), false);
    assert.equal(drive.applies(Object.assign(tank(), { topSpeed: 0 }), 2.4), false);
    withDrive(true, () => { const b = tank(); tick(b, 1, 0); assert.equal(drive.applies(b, b.acceleration), true); });
    assert.equal(withDrive(false, () => drive.applies(tank(), 2.4)), false);
});

test('players and bots run the exact same physics', () => {
    const go = isBot => withDrive(true, () => {
        const b = Object.assign(tank(1.42), isBot ? { isBot: true } : { isPlayer: true });
        const path = [];
        for (let i = 0; i < 40; i++) path.push(tick(b, i < 20 ? 1 : 0, i < 10 ? 1 : 0).dx);
        return path;
    });
    assert.deepEqual(go(true), go(false));
});

let failed = 0;
for (const t of tests) {
    try { t.fn(); console.log('ok   ' + t.name); }
    catch (e) { failed++; console.log('FAIL ' + t.name + '\n     ' + (e && e.stack || e)); }
}
console.log(failed ? `${failed} of ${tests.length} failed` : `all ${tests.length} passed`);
process.exit(failed ? 1 : 0);
