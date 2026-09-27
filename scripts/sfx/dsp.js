'use strict';
// Tiny offline DSP toolkit for the Corez sound library (scripts/sfx/build.js).
// Pure JS, no deps, deterministic (every random draw comes from a seeded rng).
// Everything works on mono Float32Arrays at SR; stereo is { L, R }.

const SR = 44100;
const TAU = Math.PI * 2;

// ── randomness ─────────────────────────────────────────────────────────────
function rngOf(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
function hashStr(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
}
const rr = (rng, a, b) => a + (b - a) * rng();

// ── basics ─────────────────────────────────────────────────────────────────
const N = (sec) => Math.max(1, Math.round(sec * SR));
const V = (p) => (typeof p === 'function' ? p : () => p);
const midi = (m) => 440 * Math.pow(2, (m - 69) / 12);
// D major pentatonic, index 0 = D4. The whole library is in this key so
// every melodic cue (gems, stingers, UI chimes) sounds like one game.
const PENTA = [0, 2, 4, 7, 9];
const penta = (i) => midi(62 + PENTA[((i % 5) + 5) % 5] + 12 * Math.floor(i / 5));

// ── envelopes (functions of t in seconds) ──────────────────────────────────
// Percussive: linear attack then exponential decay.
const perc = (att, tau) => (t) => (t < att ? t / att : Math.exp(-(t - att) / tau));
// Attack / hold / exponential release (swells, pads).
const ahr = (att, hold, tau, curve = 1) => (t) => {
    if (t < att) return Math.pow(t / att, curve);
    if (t < att + hold) return 1;
    return Math.exp(-(t - att - hold) / tau);
};
// Exponential pitch drop from f0 toward f1 with time constant tau.
const sweep = (f0, f1, tau) => (t) => f1 + (f0 - f1) * Math.exp(-t / tau);
// Exponential glide from f0 to f1 over dur, then hold.
const glide = (f0, f1, dur) => (t) => (t >= dur ? f1 : f0 * Math.pow(f1 / f0, t / dur));
const lin = (a, b, dur) => (t) => (t >= dur ? b : a + (b - a) * (t / dur));

// ── oscillators ────────────────────────────────────────────────────────────
function polyblep(t, dt) {
    if (t < dt) { t /= dt; return t + t - t * t - 1; }
    if (t > 1 - dt) { t = (t - 1) / dt; return t * t + t + t + 1; }
    return 0;
}
function osc({ type = 'sine', f, dur, amp = 1, phase = 0 }) {
    const n = N(dur), out = new Float32Array(n), F = V(f), A = V(amp);
    let ph = phase;
    for (let i = 0; i < n; i++) {
        const t = i / SR, fr = F(t), dt = Math.min(0.49, Math.abs(fr) / SR);
        let s;
        if (type === 'sine') s = Math.sin(TAU * ph);
        else if (type === 'tri') s = 1 - 4 * Math.abs(((ph + 0.25) % 1) - 0.5);
        else if (type === 'saw') s = 2 * ph - 1 - polyblep(ph, dt);
        else s = (ph < 0.5 ? 1 : -1) + polyblep(ph, dt) - polyblep((ph + 0.5) % 1, dt);
        out[i] = s * A(t);
        ph += fr / SR; ph -= Math.floor(ph);
    }
    return out;
}
// Two-operator FM: carrier f, modulator f*ratio, index(t).
function fm({ f, ratio = 2, index = 1, dur, amp = 1, fb = 0 }) {
    const n = N(dur), out = new Float32Array(n), F = V(f), I = V(index), A = V(amp), R = V(ratio);
    let pc = 0, pm = 0, last = 0;
    for (let i = 0; i < n; i++) {
        const t = i / SR, fr = F(t);
        const m = Math.sin(TAU * pm + fb * last);
        last = m;
        out[i] = Math.sin(TAU * pc + I(t) * m) * A(t);
        pc += fr / SR; pm += (fr * R(t)) / SR;
        pc -= Math.floor(pc); pm -= Math.floor(pm);
    }
    return out;
}
// Sum of exponentially-decaying sine partials. modes: [{f, a, tau, ph}].
// This is the workhorse for stone, wood, glass and bells.
function modal(modes, dur, att = 0.0006) {
    const n = N(dur), out = new Float32Array(n);
    for (const m of modes) {
        if (m.f >= SR * 0.45) continue;
        const w = (TAU * m.f) / SR, dec = Math.exp(-1 / (m.tau * SR)), attN = Math.max(1, att * SR);
        let amp = m.a, ph = m.ph || 0;
        const lim = Math.min(n, Math.ceil(m.tau * SR * 9));
        for (let i = 0; i < lim; i++) {
            const e = i < attN ? i / attN : 1;
            out[i] += Math.sin(ph + w * i) * amp * e;
            amp *= dec;
        }
    }
    return out;
}
// Tuned additive pluck: bright attack, higher partials die first.
function pluck(f, dur, { bright = 1, tau = 0.5, partials = 14, inharm = 0, att = 0.002 } = {}) {
    const modes = [];
    for (let k = 1; k <= partials; k++) {
        const fk = f * k * (1 + inharm * k * k);
        if (fk > 15000) break;
        modes.push({ f: fk, a: Math.pow(k, -1.15) * (k === 1 ? 1 : bright), tau: tau / (1 + (k - 1) * 0.55), ph: 0 });
    }
    return modal(modes, dur, att);
}
// Glassy FM bell: carrier f, inharmonic modulator, decaying index.
function bell(f, dur, { ratio = 3.5, index = 2.4, tau = 0.6, idxTau = 0.12, att = 0.001 } = {}) {
    return fm({ f, ratio, dur, index: (t) => index * Math.exp(-t / idxTau) + 0.15, amp: perc(att, tau) });
}

// ── noise ──────────────────────────────────────────────────────────────────
function noise(dur, rng, color = 'white') {
    const n = N(dur), out = new Float32Array(n);
    if (color === 'white') { for (let i = 0; i < n; i++) out[i] = rng() * 2 - 1; return out; }
    if (color === 'brown') {
        let l = 0;
        for (let i = 0; i < n; i++) { l = (l + (rng() * 2 - 1) * 0.02) * 0.998; out[i] = l * 12; }
        return out;
    }
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < n; i++) {
        const w = rng() * 2 - 1;
        b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759;
        b2 = 0.969 * b2 + w * 0.153852; b3 = 0.8665 * b3 + w * 0.3104856;
        b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
        out[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.2;
        b6 = w * 0.115926;
    }
    return out;
}

// ── filters ────────────────────────────────────────────────────────────────
// RBJ biquad; f may be a function of t (coefficients refresh every 16 samples).
function biquad(x, type, f, q = 0.707, gainDb = 0) {
    const F = V(f), out = new Float32Array(x.length), dyn = typeof f === 'function';
    let b0, b1, b2, a1, a2, x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    const upd = (fr) => {
        fr = Math.min(Math.max(fr, 10), SR * 0.47);
        const w = (TAU * fr) / SR, cs = Math.cos(w), sn = Math.sin(w), al = sn / (2 * q), A = Math.pow(10, gainDb / 40);
        let a0;
        switch (type) {
            case 'lp': b0 = (1 - cs) / 2; b1 = 1 - cs; b2 = b0; a0 = 1 + al; a1 = -2 * cs; a2 = 1 - al; break;
            case 'hp': b0 = (1 + cs) / 2; b1 = -(1 + cs); b2 = b0; a0 = 1 + al; a1 = -2 * cs; a2 = 1 - al; break;
            case 'bp': b0 = al; b1 = 0; b2 = -al; a0 = 1 + al; a1 = -2 * cs; a2 = 1 - al; break;
            case 'peak': b0 = 1 + al * A; b1 = -2 * cs; b2 = 1 - al * A; a0 = 1 + al / A; a1 = -2 * cs; a2 = 1 - al / A; break;
            case 'hs': { const s = 2 * Math.sqrt(A) * al;
                b0 = A * ((A + 1) + (A - 1) * cs + s); b1 = -2 * A * ((A - 1) + (A + 1) * cs); b2 = A * ((A + 1) + (A - 1) * cs - s);
                a0 = (A + 1) - (A - 1) * cs + s; a1 = 2 * ((A - 1) - (A + 1) * cs); a2 = (A + 1) - (A - 1) * cs - s; break; }
            case 'ls': { const s = 2 * Math.sqrt(A) * al;
                b0 = A * ((A + 1) - (A - 1) * cs + s); b1 = 2 * A * ((A - 1) - (A + 1) * cs); b2 = A * ((A + 1) - (A - 1) * cs - s);
                a0 = (A + 1) + (A - 1) * cs + s; a1 = -2 * ((A - 1) + (A + 1) * cs); a2 = (A + 1) + (A - 1) * cs - s; break; }
            default: throw new Error('filter ' + type);
        }
        b0 /= a0; b1 /= a0; b2 /= a0; a1 /= a0; a2 /= a0;
    };
    upd(F(0));
    for (let i = 0; i < x.length; i++) {
        if (dyn && (i & 15) === 0) upd(F(i / SR));
        const xi = x[i], y = b0 * xi + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
        x2 = x1; x1 = xi; y2 = y1; y1 = y; out[i] = y;
    }
    return out;
}
const lp = (x, f, q) => biquad(x, 'lp', f, q);
const hp = (x, f, q) => biquad(x, 'hp', f, q);
const bp = (x, f, q) => biquad(x, 'bp', f, q);
// One-pole DC blocker (~8 Hz).
function dcBlock(x) {
    const out = new Float32Array(x.length);
    let x1 = 0, y1 = 0;
    for (let i = 0; i < x.length; i++) { const y = x[i] - x1 + 0.9989 * y1; x1 = x[i]; y1 = y; out[i] = y; }
    return out;
}

// ── shaping / arithmetic ───────────────────────────────────────────────────
function env(x, e) { const E = V(e); for (let i = 0; i < x.length; i++) x[i] *= E(i / SR); return x; }
function gain(x, g) { for (let i = 0; i < x.length; i++) x[i] *= g; return x; }
function drive(x, amt) {
    const k = Math.tanh(amt);
    for (let i = 0; i < x.length; i++) x[i] = Math.tanh(amt * x[i]) / k;
    return x;
}
// Stepped sample-and-hold (lo-fi / glitch colour).
function crush(x, holdN, bits = 16) {
    const q = Math.pow(2, bits - 1);
    let hold = 0;
    for (let i = 0; i < x.length; i++) { if (i % holdN === 0) hold = Math.round(x[i] * q) / q; x[i] = hold; }
    return x;
}
function peakOf(x) { let p = 0; for (let i = 0; i < x.length; i++) { const a = Math.abs(x[i]); if (a > p) p = a; } return p; }
function norm(x, to = 1) { const p = peakOf(x); return p > 0 ? gain(x, to / p) : x; }
function fade(x, inS = 0.0005, outS = 0.005) {
    const ni = Math.min(x.length, N(inS)), no = Math.min(x.length, N(outS));
    for (let i = 0; i < ni; i++) x[i] *= i / ni;
    for (let i = 0; i < no; i++) x[x.length - 1 - i] *= i / no;
    return x;
}

// A mixing canvas that grows as layers are added.
class Mix {
    constructor(dur = 0) { this.b = new Float32Array(N(dur)); }
    // Every layer ends on a raised-cosine release (25% of its length, max
    // 120 ms) so a tone whose envelope has not fully died never clicks off.
    add(src, at = 0, g = 1) {
        const o = Math.round(at * SR), need = o + src.length;
        if (need > this.b.length) { const nb = new Float32Array(need); nb.set(this.b); this.b = nb; }
        const fl = Math.min(Math.floor(src.length * 0.25), N(0.12)), fs = src.length - fl;
        for (let i = 0; i < src.length; i++) {
            const w = i < fs ? 1 : 0.5 + 0.5 * Math.cos(Math.PI * (i - fs) / fl);
            this.b[o + i] += src[i] * g * w;
        }
        return this;
    }
    get out() { return this.b; }
}

// ── space ──────────────────────────────────────────────────────────────────
// Freeverb (Jezar) — 8 combs + 4 allpasses per side. Returns dry+wet.
const COMBS = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
const APS = [556, 441, 341, 225];
function reverbSide(x, { room, damp, spread, tail }) {
    const n = x.length + N(tail), out = new Float32Array(n);
    const fbk = room * 0.28 + 0.7, d1 = damp * 0.4, d2 = 1 - d1;
    const combs = COMBS.map((c) => ({ buf: new Float32Array(c + spread), i: 0, store: 0 }));
    const aps = APS.map((a) => ({ buf: new Float32Array(a + spread), i: 0 }));
    for (let s = 0; s < n; s++) {
        const inp = (s < x.length ? x[s] : 0) * 0.015;
        let acc = 0;
        for (const c of combs) {
            const y = c.buf[c.i];
            c.store = y * d2 + c.store * d1;
            c.buf[c.i] = inp + c.store * fbk;
            if (++c.i >= c.buf.length) c.i = 0;
            acc += y;
        }
        for (const a of aps) {
            const b = a.buf[a.i];
            a.buf[a.i] = acc + b * 0.5;
            acc = b - acc;
            if (++a.i >= a.buf.length) a.i = 0;
        }
        out[s] = acc;
    }
    return out;
}
function reverb(x, { room = 0.5, damp = 0.5, wet = 0.25, dry = 1, tail = 1.2, stereo = false, pre = 0, hpf = 180 } = {}) {
    let src = x;
    if (hpf) src = hp(x, hpf, 0.7);             // keep the low end dry and tight
    if (pre > 0) { const p = new Float32Array(src.length + N(pre)); p.set(src, N(pre)); src = p; }
    const L = reverbSide(src, { room, damp, spread: 0, tail });
    const mixSide = (w) => { const o = new Float32Array(w.length); for (let i = 0; i < w.length; i++) o[i] = w[i] * wet * 3 + (i < x.length ? x[i] * dry : 0); return o; };
    if (!stereo) return mixSide(L);
    const R = reverbSide(src, { room, damp, spread: 23, tail });
    return { L: mixSide(L), R: mixSide(R) };
}
// Short slap/echo.
function echo(x, time, fbk, mixG, tail = 0.6) {
    const d = N(time), n = x.length + N(tail), out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        const dry = i < x.length ? x[i] : 0;
        out[i] = dry + (i >= d ? out[i - d] * fbk : 0);
    }
    for (let i = 0; i < n; i++) out[i] = (i < x.length ? x[i] : 0) * (1 - mixG) + out[i] * mixG;
    return out;
}
// Mono -> stereo with a tiny Haas offset for width.
function widen(x, ms = 7, side = 0.35) {
    const d = N(ms / 1000), L = new Float32Array(x.length + d), R = new Float32Array(x.length + d);
    for (let i = 0; i < x.length; i++) { L[i] += x[i]; R[i + d] += x[i] * side; R[i] += x[i] * (1 - side); }
    return { L, R };
}

// ── loudness / limiting ────────────────────────────────────────────────────
// ITU BS.1770 K-weighting (RBJ approximation of the pre-filter + RLB).
function kWeight(x) { return biquad(biquad(x, 'hs', 1681.97, 0.7072, 4.0), 'hp', 38.13, 0.5); }
// Max momentary loudness over a sliding window (default 100 ms) in LUFS-ish.
// Short game sfx are shorter than the 400 ms BS.1770 block, so the loudest
// 100 ms is the fair "how loud does this hit" number.
function loudMax(x, win = 0.1) {
    const k = kWeight(x), w = Math.min(k.length, N(win));
    let acc = 0, best = 0;
    for (let i = 0; i < k.length; i++) {
        acc += k[i] * k[i];
        if (i >= w) acc -= k[i - w] * k[i - w];
        if (i >= w - 1 && acc > best) best = acc;
    }
    if (k.length < w) best = acc;
    const ms = best / w;
    return ms > 0 ? -0.691 + 10 * Math.log10(ms) : -120;
}
// Ungated integrated loudness over the whole clip.
function loudInt(x) {
    const k = kWeight(x);
    let acc = 0;
    for (let i = 0; i < k.length; i++) acc += k[i] * k[i];
    const ms = acc / Math.max(1, k.length);
    return ms > 0 ? -0.691 + 10 * Math.log10(ms) : -120;
}
// Look-ahead peak limiter: never lets |x| exceed ceil, 1.5 ms look-ahead,
// 60 ms release. Operates on one or two channels with linked gain.
function limit(chs, ceil = 0.89, look = 0.0015, rel = 0.06) {
    const n = chs[0].length, la = N(look);
    const need = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        let a = 0;
        for (const c of chs) a = Math.max(a, Math.abs(c[i]));
        need[i] = a > ceil ? ceil / a : 1;
    }
    // running minimum over the look-ahead window
    const g = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        let m = 1;
        for (let j = i; j < Math.min(n, i + la + 1); j++) if (need[j] < m) m = need[j];
        g[i] = m;
    }
    // smooth: instant attack (already looked ahead), exponential release
    const rc = Math.exp(-1 / (rel * SR));
    let cur = 1;
    for (let i = 0; i < n; i++) {
        cur = g[i] < cur ? g[i] : g[i] + (cur - g[i]) * rc;
        g[i] = cur;
    }
    for (const c of chs) for (let i = 0; i < n; i++) c[i] *= g[i];
    // safety clamp for the rare smoothing overshoot
    for (const c of chs) for (let i = 0; i < n; i++) if (Math.abs(c[i]) > ceil) c[i] = Math.sign(c[i]) * ceil;
    return chs;
}
function trimTail(chs, thrDb = -66, keep = 0.01) {
    const thr = Math.pow(10, thrDb / 20);
    let last = 0;
    for (const c of chs) for (let i = c.length - 1; i >= 0; i--) if (Math.abs(c[i]) > thr) { last = Math.max(last, i); break; }
    const end = Math.min(chs[0].length, last + N(keep));
    return chs.map((c) => c.slice(0, end));
}

module.exports = {
    SR, TAU, N, V, rngOf, hashStr, rr, midi, penta, PENTA,
    perc, ahr, sweep, glide, lin,
    osc, fm, modal, pluck, bell, noise,
    biquad, lp, hp, bp, dcBlock,
    env, gain, drive, crush, peakOf, norm, fade, Mix,
    reverb, echo, widen,
    kWeight, loudMax, loudInt, limit, trimTail,
};
