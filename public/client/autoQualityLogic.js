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
    SLOW_FOR: 3000,     // for this long
    LONG_MS: 50,        // a frame this long is a hitch
    LONG_N: 8,          // and this many in LONG_WINDOW is lagging too
    LONG_WINDOW: 3000,
    COOLDOWN: 4000,     // between two steps
    UP_AFTER: 20000,    // smooth this long before stepping back up
    UP_WORK: 9,         // the 30 fps cap comes off only when a frame's work fits 60 fps easily
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
        this.longs = [];
        this.slowSince = 0;
        this.smoothSince = 0;
        this.changedAt = -1e9;
        this.upAt = 0;
        this.holdUntil = 0;
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

    // One drawn frame: dt since the last one, work = ms spent drawing it,
    // capped = the 30 fps cap is on. Returns +1 (stepped down), -1 (stepped
    // up) or 0.
    frame(now, dt, work = 0, capped = false) {
        const T = this.T;
        if (!(dt > 0) || dt > 250) { this.reset(); return 0; }   // a stall or a hidden tab
        this.ema = this.ema * 0.9 + dt * 0.1;
        this.work = this.work * 0.9 + (work > 0 ? work : 0) * 0.1;
        if (dt > T.LONG_MS) this.longs.push(now);
        while (this.longs.length && now - this.longs[0] > T.LONG_WINDOW) this.longs.shift();
        // a change settles first: its slow (or smooth) stretch starts after
        if (now - this.changedAt < this.T.COOLDOWN) return 0;
        const target = capped ? 1000 / 30 : 1000 / 60;
        const slow = this.ema > (capped ? T.SLOW_MS_30 : T.SLOW_MS);
        if (slow) { this.smoothSince = 0; if (!this.slowSince) this.slowSince = now; }
        else if (this.ema < target * 1.12 && !this.longs.length) { this.slowSince = 0; if (!this.smoothSince) this.smoothSince = now; }
        else { this.slowSince = 0; this.smoothSince = 0; }

        const lagging = (this.slowSince && now - this.slowSince > T.SLOW_FOR) || this.longs.length >= T.LONG_N;
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
