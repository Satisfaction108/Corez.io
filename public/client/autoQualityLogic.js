// Automatic low-end trim, the logic only (autoQuality.js wires it up).
//
// A device that looks weak at startup starts a few rungs down, and while
// frames run slow the ladder steps down one rung at a time (a cooldown
// between steps); after a long smooth stretch it steps back up. Rungs, in
// the order they go:
//   fxLow          Effects to Low: fewer particles, rarer glitches
//   fewerFx        Fewer Effects: no light leaks, dust motes, soft vignette
//   simpleTerrain  plainer rock shading
//   fps30          the 30 FPS cap
// Past the last one the automatic resolution (app.js autoRes) takes over.
// A rung the player set by hand, or one already on, is skipped: it costs
// nothing and is never switched for them.

export const RUNGS = ['fxLow', 'fewerFx', 'simpleTerrain', 'fps30'];

export const TUNE = {
    SLOW_MS: 22,        // smoothed frame time over this (60 fps) is lagging
    SLOW_MS_30: 40,     // ...or this with the 30 fps cap on
    SLOW_FOR: 5000,     // for this long (a sustained dip, not a fight's worth of hitches)
    LONG_MS: 50,        // a frame this long is a hitch
    LONG_N: 10,         // and this many in LONG_WINDOW is lagging too...
    LONG_WINDOW: 6000,
    LONG_SPAN: 3000,    // ...spread over at least this long (one GC burst is not lag)
    STALL: 250,         // a frame gap this long is a stall or a hidden tab, not a slow frame
    GRACE: 3000,        // and the frames right after one (refocus, GC, shader warm-up) don't count
    COOLDOWN: 4000,     // between two steps
    UP_AFTER: 20000,    // smooth this long before stepping back up
    UP_WORK: 12,        // the 30 fps cap comes off when a frame's work fits 60 fps with room to spare
    PIN_WORK: 12,       // a steady 30 with less work than this is a capped screen, not lag
    CAP_WORK: 28,       // and goes on only when a frame fits 30 fps (else it can't help: resolution)
    BOUNCE: 15000,      // a step down this soon after a step up...
    HOLD: 300000,       // ...keeps it down this long
};

// Where a device starts. env: { cores, memory, softGl, mobile, dpr }.
// memory is navigator.deviceMemory (Chrome only, capped at 8).
export function startRung(env = {}) {
    const cores = env.cores > 0 ? env.cores : 8;
    const mem = env.memory > 0 ? env.memory : 8;
    if (env.softGl || cores <= 2 || mem <= 2) return 3;
    const weak = cores <= 4 || mem <= 4;
    if (weak) return 2;
    // a very sharp panel on a mid chip, or any phone
    if (env.mobile || (env.dpr >= 2.5 && cores <= 6)) return 1;
    return 0;
}

export class Ladder {
    constructor(start = 0, tune = TUNE) {
        this.T = tune;
        this.rung = Math.max(0, Math.min(RUNGS.length, start | 0));
        this.skip = new Set();
        this.ema = 16.7;
        this.work = 5;
        this.jit = 0;
        this.longs = [];
        this.slowSince = 0;
        this.smoothSince = 0;
        this.changedAt = -1e9;
        this.upAt = 0;
        this.holdUntil = 0;
        this.graceUntil = 0;
    }
    // is this rung in force right now (and not one the player owns)
    on(name) {
        const i = RUNGS.indexOf(name);
        return i >= 0 && i < this.rung && !this.skip.has(name);
    }
    active() { return RUNGS.some(r => this.on(r)); }
    // nothing cheaper left here: resolution's turn. The cap is no help to
    // frames that already take longer than 33 ms to draw.
    useless(name) { return this.skip.has(name) || (name === 'fps30' && this.work > this.T.CAP_WORK); }
    exhausted() {
        for (let i = this.rung; i < RUNGS.length; i++) if (!this.useless(RUNGS[i])) return false;
        return true;
    }
    setSkip(names) { this.skip = new Set(names); }
    reset() { this.slowSince = this.smoothSince = 0; this.longs.length = 0; }
    // a hidden tab, a dive, the menu: nothing counts, and a grace after
    pause(now) { this.reset(); this.graceUntil = now + this.T.GRACE; }

    // One drawn frame: dt since the last one, work = ms spent drawing it,
    // capped = the 30 fps cap is on. Returns +1 (stepped down), -1 (stepped
    // up) or 0.
    frame(now, dt, work = 0, capped = false) {
        const T = this.T;
        // a stall or a hidden tab, then a few seconds of settling after it
        if (!(dt > 0) || dt > T.STALL) { this.reset(); this.graceUntil = now + T.GRACE; return 0; }
        if (now < this.graceUntil) return 0;
        this.ema = this.ema * 0.9 + dt * 0.1;
        this.work = this.work * 0.9 + (work > 0 ? work : 0) * 0.1;
        this.jit = this.jit * 0.9 + Math.abs(dt - this.ema) * 0.1;
        if (dt > T.LONG_MS) this.longs.push(now);
        while (this.longs.length && now - this.longs[0] > T.LONG_WINDOW) this.longs.shift();
        // a change settles first: its slow (or smooth) stretch starts after
        if (now - this.changedAt < this.T.COOLDOWN) return 0;
        const target = capped ? 1000 / 30 : 1000 / 60;
        // Chrome's battery saver (or a 30 Hz screen) holds frames to a dead
        // steady 30 however cheap they are: that is not lag, and cheaper
        // settings would only make it look worse
        const pinned = !capped && Math.abs(this.ema - 1000 / 30) < 3 && this.jit < 2.5 && this.work < T.PIN_WORK && !this.longs.length;
        const slow = !pinned && this.ema > (capped ? T.SLOW_MS_30 : T.SLOW_MS);
        if (pinned) { this.slowSince = 0; if (!this.smoothSince) this.smoothSince = now; }
        else if (slow) { this.smoothSince = 0; if (!this.slowSince) this.slowSince = now; }
        else if (this.ema < target * 1.12 && !this.longs.length) { this.slowSince = 0; if (!this.smoothSince) this.smoothSince = now; }
        else { this.slowSince = 0; this.smoothSince = 0; }

        const hitchy = this.longs.length >= T.LONG_N && this.longs[this.longs.length - 1] - this.longs[0] >= T.LONG_SPAN;
        const lagging = (this.slowSince && now - this.slowSince > T.SLOW_FOR) || hitchy;
        if (lagging) {
            if (this.exhausted()) return 0;
            // skipped rungs cost nothing: go past them to one that helps
            do this.rung++; while (this.rung < RUNGS.length && this.useless(RUNGS[this.rung - 1]));
            if (this.upAt && now - this.upAt < T.BOUNCE) this.holdUntil = now + T.HOLD;
            this.changedAt = now;
            this.reset();
            return 1;
        }
        if (this.smoothSince && now - this.smoothSince > T.UP_AFTER && now > this.holdUntil && this.rung > 0) {
            let r = this.rung;
            while (r > 0 && this.skip.has(RUNGS[r - 1])) r--;
            if (r === 0) return 0;
            // dropping the cap: only with room to spare at 60
            if (RUNGS[r - 1] === 'fps30' && this.work > T.UP_WORK) return 0;
            this.rung = r - 1;
            this.upAt = this.changedAt = now;
            this.reset();
            return -1;
        }
        return 0;
    }
}

// ── automatic resolution (app.js resizeEvent applies it) ──────────────────
// Each level keeps STEP of the pixels the level above had (about 87% per
// side), down to a floor where HUD text would turn to mush. Small steps,
// one at a time, only after a sustained dip, and back up one at a time:
// the old ladder dropped a retina screen straight to 1080p (about half the
// sharpness, nearest-neighbour stretched) on a two-second dip, which read
// as the whole game "turning grainy" until it stepped back up.
export const RES = {
    STEP: 0.75,         // pixel share kept per level
    FLOOR: 1100 * 820,
    SLOW_MS: 38,        // smoothed frame time over this (under ~26 fps; not 30: battery saver pins 30)
    BAD_MS: 60,         // over this (under ~16 fps) is a weak device, not a dip
    SLOW_FOR: 5000,     // slow this long before a step down
    BAD_FOR: 2500,      // or this long when it is that bad
    SMOOTH_MS: 24,      // holding ~42 fps or better...
    UP_AFTER: 15000,    // ...this long steps back up one level
    SETTLE: 1500,       // after a change
    STALL: 400,         // a gap this long is a hidden tab or a stall
    GRACE: 3000,        // and the frames after it (refocus, GC, rebuilds) don't count
    BOUNCE: 12000,      // slow again this soon after a step up...
    HOLD: 300000,       // ...keeps it down this long
};

// The pixel budget at a level: Infinity at 0 (native), never under floor.
export function resBudget(level, native, floor = RES.FLOOR, T = RES) {
    if (!(level > 0)) return Infinity;
    return Math.max(floor, native * Math.pow(T.STEP, level));
}
// How many levels a screen of `native` pixels has before the floor.
export function resLevels(native, floor = RES.FLOOR, T = RES) {
    if (!(native > floor)) return 0;
    return Math.ceil(Math.log(floor / native) / Math.log(T.STEP));
}

export class ResGovernor {
    constructor(level = 0, tune = RES) {
        this.T = tune;
        this.level = Math.max(0, level | 0);
        this.ema = 16.7;
        this.slowSince = this.smoothSince = 0;
        this.changedAt = -1e9;
        this.upAt = 0;
        this.noUpUntil = 0;
        this.graceUntil = 0;
    }
    reset() { this.slowSince = this.smoothSince = 0; }
    // a hidden tab, the menu, a dive: nothing counts, and a grace after
    pause(now) { this.reset(); this.graceUntil = now + this.T.GRACE; }
    // One rAF tick. turn(ema) says whether the effects ladder is done (it
    // goes first); max is the deepest level this screen has. Returns the
    // level change: +1 (lower resolution), -1 (higher) or 0.
    frame(now, dt, turn = () => true, max = 1) {
        const T = this.T;
        if (!(dt > 0) || dt > T.STALL) { this.pause(now); return 0; }
        if (now < this.graceUntil) return 0;
        this.ema = this.ema * 0.92 + dt * 0.08;
        if (now - this.changedAt < T.SETTLE) return 0;
        if (this.level > max) return this.set(now, max) ? -1 : 0;
        if (this.ema > T.SLOW_MS && turn(this.ema)) {
            this.smoothSince = 0;
            if (!this.slowSince) this.slowSince = now;
            const need = this.ema > T.BAD_MS ? T.BAD_FOR : T.SLOW_FOR;
            if (now - this.slowSince > need && this.level < max) {
                // stepping up just caused this: go back and stay there a while
                if (this.upAt && now - this.upAt < T.BOUNCE) this.noUpUntil = now + T.HOLD;
                this.set(now, this.level + 1);
                return 1;
            }
        } else if (this.ema < T.SMOOTH_MS) {
            this.slowSince = 0;
            if (!this.smoothSince) this.smoothSince = now;
            if (this.level > 0 && now > this.noUpUntil && now - this.smoothSince > T.UP_AFTER) {
                this.upAt = now;
                this.set(now, this.level - 1);
                return -1;
            }
        } else this.reset();
        return 0;
    }
    set(now, level) {
        level = Math.max(0, level | 0);
        if (level === this.level) return false;
        this.level = level;
        this.changedAt = now;
        this.reset();
        return true;
    }
}
