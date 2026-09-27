'use strict';
// Corez sound library — every sound in the game, designed as code.
//
// Palette (so the whole game sounds like one thing):
//   key      D major pentatonic (D E F# A B). Every chime, stinger and UI tone.
//   gems     crystalline modal chimes; pitch AND brightness climb per tier:
//            copper = warm marimba wood, azurite = bright glass bar,
//            purple = shimmering detuned chorus, emerald = rich sparkling chord.
//   rock     chunky low stone modes + gritty transient; breaks crunch and
//            crumble with granular debris.
//   weapons  mechanical punch: transient click + pitch-dropping body + air.
//            Each gun family has its own pitch/length/texture fingerprint.
//   ui       soft rounded bubble pops, quiet and short.
//   stingers short musical moments (plucks, bells, brass) with a stereo room.
//
// Each recipe: (rng, variantIndex) => Float32Array (mono) | { L, R } (stereo).
const D = require('./dsp.js');
const {
    SR, N, rr, midi, penta, perc, ahr, sweep, glide, lin,
    osc, fm, modal, pluck, bell, noise, biquad, lp, hp, bp,
    env, gain, drive, crush, norm, Mix, reverb, echo, widen,
} = D;

// ── building blocks ────────────────────────────────────────────────────────
// Transient: a millisecond-scale filtered noise tick. Gives every hit its edge.
const click = (rng, { f = 3200, q = 0.8, tau = 0.0012, dur = 0.014, color = 'white' } = {}) =>
    env(bp(noise(dur, rng, color), f, q), perc(0.0002, tau));
// Pitch-dropping tone (kick-drum body).
const thump = (f0, f1, ptau, atau, dur, { type = 'sine', att = 0.0008 } = {}) =>
    osc({ type, f: sweep(f0, f1, ptau), dur, amp: perc(att, atau) });
// Filtered noise burst with percussive envelope; f may be a function.
const burst = (rng, { dur, color = 'white', type = 'bp', f, q = 0.8, att = 0.0005, tau }) =>
    env(biquad(noise(dur, rng, color), type, f, q), perc(att, tau));
// Band-passed noise sweep with a swell envelope.
const whoosh = (rng, { dur, f0, f1, q = 1.4, att, tau, hold = 0, color = 'pink' }) =>
    env(bp(noise(dur, rng, color), glide(f0, f1, dur), q), ahr(att, hold, tau, 2));
const rumble = (rng, { dur, f = 140, att = 0.01, tau = 0.3, hold = 0 }) =>
    env(lp(noise(dur, rng, 'brown'), f, 0.8), ahr(att, hold, tau));
// Tiny high sine blips: sparkle / glitter. Optionally quantised to the key.
function sparkles(rng, { count, spread, fLo = 2500, fHi = 7000, tau = 0.04, amp = 0.3, t0 = 0, tuned = false, rise = 0 }) {
    const m = new Mix(t0 + spread + tau * 8);
    for (let i = 0; i < count; i++) {
        const u = count > 1 ? i / (count - 1) : 0;
        const at = t0 + (rise ? u * spread : rng() * spread);
        let f = rr(rng, fLo, fHi) * (1 + rise * u);
        if (tuned) { const idx = Math.round(Math.log2(f / 293.66) * 5); f = penta(idx); }
        const a = amp * rr(rng, 0.5, 1) * (1 - 0.4 * u);
        m.add(osc({ f, dur: tau * 7, amp: perc(0.0012, tau) }), at, a);
    }
    return m.out;
}
// Granular debris: many tiny band-passed noise grains, density decaying.
function crumble(rng, { dur, count, fLo = 500, fHi = 3500, amp = 0.35, curve = 2, t0 = 0, gdur = [0.004, 0.02] }) {
    const m = new Mix(t0 + dur + 0.05);
    for (let i = 0; i < count; i++) {
        const u = Math.pow(rng(), curve);                // bunch early
        const g = rr(rng, gdur[0], gdur[1]);
        const f = rr(rng, fLo, fHi) * (1 - 0.35 * u);    // later bits are smaller & duller
        const grain = env(bp(noise(g + 0.004, rng), f, rr(rng, 1.2, 3)), perc(0.0004, g * 0.35));
        m.add(grain, t0 + u * dur, amp * rr(rng, 0.3, 1) * (1 - 0.7 * u));
    }
    return m.out;
}
// Two detuned saws through a moving lowpass: brassy horn.
function brass(f, dur, { att = 0.018, bright = 2800, base = 500, vib = 0.004, tau = 0.25, hold = 0.1 } = {}) {
    const F = (t) => f * (1 + vib * Math.sin(2 * Math.PI * 5.5 * t) * Math.min(1, t / 0.15));
    const a = osc({ type: 'saw', f: F, dur });
    const b = osc({ type: 'saw', f: (t) => F(t) * 1.006, dur });
    const s = new Float32Array(a.length);
    for (let i = 0; i < s.length; i++) s[i] = (a[i] + b[i]) * 0.5;
    const cut = (t) => base + (bright - base) * (t < att * 1.5 ? t / (att * 1.5) : Math.exp(-(t - att * 1.5) / (tau * 1.3)));
    return env(biquad(s, 'lp', cut, 1.1), ahr(att, hold, tau));
}
// Warm pad: detuned saws softly lowpassed.
function pad(freqs, dur, { att = 0.2, hold = 0.3, tau = 0.5, cut = 1600 } = {}) {
    const m = new Mix(dur);
    for (const f of freqs) for (const d of [0.996, 1.004]) m.add(osc({ type: 'saw', f: f * d, dur }), 0, 0.5 / freqs.length);
    return env(lp(m.out, cut, 0.7), ahr(att, hold, tau, 1.5));
}
const room = (x, o = {}) => reverb(x, { room: 0.55, damp: 0.45, wet: 0.2, tail: 1.1, stereo: true, ...o });
const small = (x, o = {}) => reverb(x, { room: 0.3, damp: 0.6, wet: 0.12, tail: 0.35, ...o });

// ── gem voice: the heart of the palette ───────────────────────────────────
// Tier roots, ascending: D5 (copper), A5 (azurite), D6 (purple), F#6 (emerald)
const GEM_F = { 1: midi(74), 2: midi(81), 3: midi(86), 4: midi(90) };
function gemTone(tier, rng, { dur = 0.5, len = 1 } = {}) {
    const f = GEM_F[tier] * rr(rng, 0.997, 1.003);
    const m = new Mix(dur);
    if (tier === 1) {
        // copper: marimba wood. Fundamental + the 4x bar overtone, soft knock.
        m.add(modal([
            { f, a: 1, tau: 0.16 * len }, { f: f * 3.93, a: 0.32, tau: 0.035 * len },
            { f: f * 0.5, a: 0.18, tau: 0.09 * len }, { f: f * 9.1, a: 0.06, tau: 0.012 },
        ], dur, 0.0015));
        m.add(click(rng, { f: 1800, q: 1.2, tau: 0.0018 }), 0, 0.35);
    } else if (tier === 2) {
        // azurite: bright glass bar. Clean inharmonic bar partials.
        m.add(modal([
            { f, a: 1, tau: 0.26 * len }, { f: f * 2.76, a: 0.42, tau: 0.1 * len },
            { f: f * 5.4, a: 0.2, tau: 0.045 * len }, { f: f * 8.93, a: 0.08, tau: 0.02 },
        ], dur, 0.0008));
        m.add(click(rng, { f: 5200, q: 1, tau: 0.0009 }), 0, 0.3);
    } else if (tier === 3) {
        // purple core shard: two detuned voices beat against each other, a
        // quick tremolo shimmer and an octave halo.
        for (const d of [0.9965, 1.0035]) {
            m.add(modal([
                { f: f * d, a: 0.6, tau: 0.3 * len }, { f: f * d * 2, a: 0.25, tau: 0.14 * len },
                { f: f * d * 3.01, a: 0.12, tau: 0.07 * len },
            ], dur, 0.001));
        }
        const trem = (t) => 1 - 0.28 * (0.5 + 0.5 * Math.sin(2 * Math.PI * 11 * t));
        env(m.b, trem);
        m.add(sparkles(rng, { count: 4, spread: 0.12, fLo: f * 2.5, fHi: f * 4, tau: 0.03, amp: 0.14, t0: 0.01 }));
        m.add(click(rng, { f: 6000, q: 1, tau: 0.0008 }), 0, 0.25);
    } else {
        // emerald: a rich chord (D6 + F#6 + A6) with a warm D5 body and a
        // spray of glitter on top. The best thing you can pick up.
        const chord = [[f, 1], [midi(86), 0.55], [midi(93), 0.4]];
        for (const [cf, a] of chord) {
            m.add(modal([
                { f: cf, a, tau: 0.34 * len }, { f: cf * 2.76, a: a * 0.3, tau: 0.1 * len },
                { f: cf * 5.4, a: a * 0.12, tau: 0.04 },
            ], dur, 0.0008));
        }
        m.add(osc({ f: midi(74), dur, amp: perc(0.004, 0.18 * len) }), 0, 0.22);
        m.add(sparkles(rng, { count: 9, spread: 0.22, fLo: 3500, fHi: 8000, tau: 0.03, amp: 0.16, t0: 0.015, tuned: true }));
        m.add(click(rng, { f: 6500, q: 0.9, tau: 0.0008 }), 0, 0.3);
    }
    return m.out;
}

// ── stone voice ────────────────────────────────────────────────────────────
function rockThock(rng, { base = 170, bright = 0, weight = 1 } = {}) {
    const b = base * rr(rng, 0.9, 1.12);
    const ratios = [1, 1.47, 2.09, 2.56, 3.39, 4.6];
    const m = new Mix(0.16);
    m.add(modal(ratios.map((r, i) => ({
        f: b * r * rr(rng, 0.98, 1.02), a: [1, 0.7, 0.5, 0.36, 0.26, 0.15][i] * (i > 2 ? 1 + bright : 1),
        tau: [0.05, 0.036, 0.026, 0.02, 0.014, 0.01][i],
    })), 0.16, 0.0004), 0, 0.55);
    m.add(thump(b * 0.9, b * 0.55, 0.012, 0.025, 0.1), 0, 0.55 * weight);
    m.add(click(rng, { f: 2400 + bright * 1500, q: 0.9, tau: 0.0016 }), 0, 0.8);
    m.add(burst(rng, { dur: 0.08, f: 1100 + bright * 700, q: 0.9, tau: 0.014 }), 0, 0.4);
    return drive(m.out, 1.6);
}
function rockCrunch(rng, { size = 1, crumbles = 70, dur = 0.55 } = {}) {
    const m = new Mix(dur + 0.2);
    m.add(thump(150 / size, 48, 0.028, 0.08 * size, 0.4), 0, 0.65);
    m.add(rockThock(rng, { base: 130 / size, bright: 0.3 }), 0, 0.7);
    m.add(drive(burst(rng, { dur: 0.1, f: 1900, q: 0.7, tau: 0.012 }), 3), 0, 0.55);
    m.add(crumble(rng, { dur: dur * 0.85, count: crumbles, fLo: 450, fHi: 3200, amp: 0.34, t0: 0.012 }));
    m.add(rumble(rng, { dur: dur, f: 260, att: 0.006, tau: 0.12 * size }), 0, 0.5);
    return m.out;
}

// ── weapons ────────────────────────────────────────────────────────────────
function shotLight(rng) {
    const p = rr(rng, 0.94, 1.06), m = new Mix(0.16);
    m.add(click(rng, { f: 3400 * p, q: 0.7, tau: 0.0012 }), 0, 1);
    m.add(drive(thump(720 * p, 230 * p, 0.01, 0.028, 0.12, { type: 'tri' }), 2), 0, 0.75);
    m.add(thump(150 * p, 80, 0.018, 0.028, 0.1), 0, 0.4);
    m.add(burst(rng, { dur: 0.1, color: 'pink', f: sweep(2400 * p, 900, 0.02), q: 0.9, tau: 0.022 }), 0.001, 0.7);
    return m.out;
}
function shotMG(rng) {
    const p = rr(rng, 0.93, 1.07), m = new Mix(0.1);
    m.add(click(rng, { f: 4600 * p, q: 0.8, tau: 0.0009 }), 0, 1);
    m.add(drive(thump(1050 * p, 420 * p, 0.006, 0.016, 0.08, { type: 'tri' }), 2.2), 0, 0.6);
    m.add(thump(220 * p, 120, 0.01, 0.016, 0.06), 0, 0.3);
    m.add(burst(rng, { dur: 0.06, f: 3000 * p, q: 1.1, tau: 0.012 }), 0, 0.55);
    return m.out;
}
function shotCannon(rng) {
    const p = rr(rng, 0.94, 1.06), m = new Mix(0.6);
    m.add(click(rng, { f: 1800, q: 0.6, tau: 0.002, color: 'pink' }), 0, 0.8);
    m.add(thump(95 * p, 36, 0.05, 0.14, 0.55), 0, 1);
    m.add(drive(lp(osc({ type: 'saw', f: sweep(210 * p, 58, 0.04), dur: 0.35, amp: perc(0.001, 0.07) }), sweep(2200, 260, 0.05), 0.9), 2.5), 0, 0.55);
    m.add(burst(rng, { dur: 0.45, color: 'pink', type: 'lp', f: sweep(4500, 240, 0.06), q: 0.7, tau: 0.075 }), 0, 0.85);
    m.add(rumble(rng, { dur: 0.5, f: 180, att: 0.005, tau: 0.13 }), 0, 0.45);
    return small(drive(m.out, 1.4), { wet: 0.08 });
}
function shotSniper(rng) {
    const p = rr(rng, 0.95, 1.05), m = new Mix(0.4);
    m.add(click(rng, { f: 5200, q: 0.6, tau: 0.0009 }), 0, 1);
    m.add(fm({ f: glide(2900 * p, 420, 0.07), ratio: 1.5, index: (t) => 2.2 * Math.exp(-t / 0.03), dur: 0.1, amp: perc(0.0005, 0.03) }), 0, 0.35);
    m.add(drive(thump(420 * p, 120, 0.009, 0.035, 0.14, { type: 'tri' }), 2), 0, 0.6);
    m.add(thump(110, 50, 0.03, 0.06, 0.2), 0, 0.55);
    m.add(burst(rng, { dur: 0.3, type: 'hp', f: sweep(5000, 1800, 0.05), q: 0.6, tau: 0.05 }), 0.002, 0.3);
    return echo(m.out, 0.085, 0.25, 0.22, 0.25);
}
function shotTrap(rng) {
    const p = rr(rng, 0.95, 1.05), m = new Mix(0.26);
    // mechanical clack of the launcher latch
    m.add(modal([{ f: 1150 * p, a: 1, tau: 0.03 }, { f: 2870 * p, a: 0.6, tau: 0.018 }, { f: 4110 * p, a: 0.35, tau: 0.01 }], 0.12, 0.0003), 0, 0.5);
    m.add(click(rng, { f: 2600, q: 1, tau: 0.0015 }), 0, 0.7);
    // the trap itself thunking out, then a hollow "tock"
    m.add(thump(210 * p, 95, 0.015, 0.04, 0.15), 0.004, 0.8);
    m.add(osc({ type: 'tri', f: sweep(470 * p, 380 * p, 0.03), dur: 0.12, amp: perc(0.002, 0.03) }), 0.028, 0.3);
    return drive(m.out, 1.3);
}
function droneLaunch(rng) {
    const p = rr(rng, 0.94, 1.06), m = new Mix(0.3);
    m.add(click(rng, { f: 1500, q: 1, tau: 0.0015 }), 0, 0.45);
    m.add(whoosh(rng, { dur: 0.22, f0: 500 * p, f1: 2300 * p, q: 1.6, att: 0.05, tau: 0.05 }), 0, 0.7);
    const buzz = lp(osc({ type: 'saw', f: glide(150 * p, 260 * p, 0.14), dur: 0.24 }), 1100, 1.2);
    m.add(env(buzz, ahr(0.03, 0.04, 0.05)), 0, 0.28);
    m.add(osc({ f: glide(520 * p, 780 * p, 0.1), dur: 0.2, amp: ahr(0.02, 0.02, 0.04) }), 0.01, 0.2);
    return m.out;
}

// ── combat ─────────────────────────────────────────────────────────────────
// Hitmarker: the sound of "that landed". Crisp tick + tuned ping.
function hitDealt(rng, tier) {
    const p = rr(rng, 0.97, 1.03), m = new Mix(0.25);
    const ping = [1760, 1976, 2349][tier] * p;          // A6, B6, D7
    m.add(click(rng, { f: 3800, q: 0.8, tau: 0.0009 }), 0, 0.8);
    m.add(burst(rng, { dur: 0.05, f: 2100, q: 1.2, tau: 0.008 }), 0, 0.45);
    m.add(osc({ f: sweep(ping * 1.08, ping, 0.004), dur: 0.12, amp: perc(0.0006, 0.024 + tier * 0.012) }), 0, 0.55);
    m.add(thump(380 + tier * 60, 180, 0.008, 0.02 + tier * 0.006, 0.08), 0, 0.35 + tier * 0.15);
    if (tier >= 1) m.add(osc({ f: ping * 1.5, dur: 0.1, amp: perc(0.001, 0.02) }), 0.004, 0.18);
    if (tier >= 2) {
        m.add(osc({ f: ping * 2, dur: 0.16, amp: perc(0.001, 0.04) }), 0.012, 0.14);
        m.add(sparkles(rng, { count: 3, spread: 0.05, fLo: 5000, fHi: 8000, tau: 0.018, amp: 0.1, t0: 0.01 }));
    }
    return m.out;
}
function hurt(rng, heavy) {
    const p = rr(rng, 0.94, 1.06), m = new Mix(heavy ? 0.4 : 0.25);
    m.add(click(rng, { f: 1400, q: 0.7, tau: 0.0016, color: 'pink' }), 0, 0.7);
    m.add(thump(170 * p, 58, 0.025, heavy ? 0.08 : 0.05, 0.3), 0, 1);
    m.add(drive(burst(rng, { dur: 0.16, color: 'pink', f: 850 * p, q: 1.1, tau: heavy ? 0.04 : 0.028 }), 4), 0, 0.5);
    // a dull detuned "donk" so you know it was YOU that got hit
    m.add(osc({ type: 'tri', f: sweep(330 * p, 240 * p, 0.03), dur: 0.2, amp: perc(0.002, 0.05) }), 0.003, 0.3);
    m.add(osc({ type: 'tri', f: sweep(311 * p, 226 * p, 0.03), dur: 0.2, amp: perc(0.002, 0.05) }), 0.003, 0.25);
    if (heavy) m.add(rumble(rng, { dur: 0.3, f: 150, att: 0.004, tau: 0.08 }), 0, 0.5);
    return lp(m.out, 5500, 0.7);
}
function kill(rng) {
    const m = new Mix(1.0);
    m.add(thump(150, 44, 0.03, 0.11, 0.45), 0, 0.9);
    m.add(click(rng, { f: 2600, q: 0.7, tau: 0.0014 }), 0, 0.7);
    m.add(drive(burst(rng, { dur: 0.25, color: 'pink', type: 'lp', f: sweep(5000, 400, 0.04), q: 0.7, tau: 0.04 }), 2), 0, 0.55);
    // "ding-DING": A5 then D6, glassy plucks
    m.add(pluck(midi(81), 0.5, { bright: 0.6, tau: 0.22 }), 0.03, 0.42);
    m.add(bell(midi(86), 0.8, { ratio: 3.01, index: 1.6, tau: 0.35 }), 0.1, 0.4);
    m.add(pluck(midi(86), 0.6, { bright: 0.5, tau: 0.3 }), 0.1, 0.35);
    m.add(sparkles(rng, { count: 6, spread: 0.2, fLo: 3500, fHi: 7500, tau: 0.03, amp: 0.13, t0: 0.12, tuned: true }));
    return room(m.out, { wet: 0.16 });
}
function streak(rng) {
    const m = new Mix(1.2), notes = [74, 78, 81, 86];
    notes.forEach((n, i) => m.add(brass(midi(n), 0.5, { bright: 3200, tau: 0.12 + i * 0.05, hold: 0.04 }), i * 0.075, 0.32));
    m.add(pluck(midi(90), 0.7, { bright: 0.5, tau: 0.3 }), 0.3, 0.3);
    m.add(sparkles(rng, { count: 8, spread: 0.3, fLo: 3000, fHi: 7000, tau: 0.03, amp: 0.12, t0: 0.28, tuned: true, rise: 0.4 }));
    return room(m.out, { wet: 0.2 });
}
function shutdown(rng) {
    const m = new Mix(1.4);
    // big metallic clang, then a rising whoosh into a victory bell
    m.add(modal([220, 331, 497, 617, 882, 1203].map((f, i) => ({ f, a: 1 / (i + 1), tau: 0.5 / (1 + i * 0.4) })), 1.2, 0.0005), 0, 0.5);
    m.add(thump(120, 40, 0.04, 0.12, 0.5), 0, 0.8);
    m.add(click(rng, { f: 2200, q: 0.6, tau: 0.002 }), 0, 0.7);
    m.add(whoosh(rng, { dur: 0.35, f0: 400, f1: 3500, q: 1.3, att: 0.25, tau: 0.04 }), 0.1, 0.4);
    m.add(bell(midi(86), 1.0, { ratio: 3.5, index: 2, tau: 0.45 }), 0.42, 0.4);
    m.add(bell(midi(93), 1.0, { ratio: 3.5, index: 1.4, tau: 0.4 }), 0.46, 0.25);
    return room(m.out, { wet: 0.22 });
}
function revenge(rng) {
    const m = new Mix(1.2);
    // a sly low "dun-dun" answered by the major lift: payback
    m.add(pluck(midi(59), 0.4, { bright: 0.8, tau: 0.15 }), 0, 0.5);
    m.add(pluck(midi(62), 0.4, { bright: 0.8, tau: 0.15 }), 0.11, 0.5);
    m.add(thump(110, 45, 0.03, 0.07, 0.3), 0.11, 0.5);
    m.add(brass(midi(78), 0.6, { bright: 3000, tau: 0.2 }), 0.26, 0.3);
    m.add(brass(midi(81), 0.6, { bright: 3000, tau: 0.2 }), 0.26, 0.25);
    m.add(bell(midi(86), 0.9, { ratio: 3.01, index: 1.5, tau: 0.4 }), 0.3, 0.35);
    m.add(sparkles(rng, { count: 5, spread: 0.2, fLo: 3000, fHi: 6500, tau: 0.03, amp: 0.1, t0: 0.32, tuned: true }));
    return room(m.out, { wet: 0.2 });
}
function lowHealth(rng) {
    const m = new Mix(0.7);
    for (const at of [0, 0.19]) {
        m.add(lp(osc({ type: 'tri', f: midi(76), dur: 0.16, amp: ahr(0.006, 0.05, 0.03) }), 2400), at, 0.45);
        m.add(thump(90, 50, 0.02, 0.05, 0.16), at, 0.45);
    }
    return m.out;
}
function shieldUp(rng) {
    const m = new Mix(0.8);
    const tr = (t) => 0.75 + 0.25 * Math.sin(2 * Math.PI * 17 * t);
    for (const [f, a] of [[midi(69), 0.5], [midi(76), 0.35], [midi(81), 0.3], [midi(88), 0.14]]) {
        m.add(osc({ f: glide(f * 0.94, f, 0.25), dur: 0.7, amp: (t) => ahr(0.22, 0.08, 0.16, 2)(t) * tr(t) }), 0, a);
    }
    m.add(whoosh(rng, { dur: 0.4, f0: 600, f1: 5000, q: 1.2, att: 0.26, tau: 0.06 }), 0, 0.3);
    m.add(sparkles(rng, { count: 6, spread: 0.25, fLo: 3000, fHi: 7000, tau: 0.03, amp: 0.1, t0: 0.15, tuned: true, rise: 0.3 }));
    return room(m.out, { wet: 0.18 });
}
function shieldBreak(rng) {
    const m = new Mix(0.6);
    m.add(click(rng, { f: 6000, q: 0.6, tau: 0.001 }), 0, 0.8);
    m.add(burst(rng, { dur: 0.2, type: 'hp', f: 3500, q: 0.7, tau: 0.03 }), 0, 0.45);
    // glass partials falling apart
    const modes = [];
    for (let i = 0; i < 9; i++) modes.push({ f: rr(rng, 2200, 7500), a: rr(rng, 0.2, 0.6), tau: rr(rng, 0.02, 0.09) });
    m.add(modal(modes, 0.4, 0.0003), 0.002, 0.4);
    m.add(osc({ f: glide(1300, 280, 0.3), dur: 0.35, amp: perc(0.004, 0.09) }), 0.01, 0.35);
    m.add(thump(180, 70, 0.02, 0.05, 0.2), 0, 0.4);
    return small(m.out, { wet: 0.15 });
}
function playerDeath(rng) {
    const m = new Mix(1.8);
    m.add(thump(130, 32, 0.06, 0.25, 1.0), 0, 1);
    m.add(click(rng, { f: 1500, q: 0.6, tau: 0.002, color: 'pink' }), 0, 0.7);
    m.add(burst(rng, { dur: 0.8, color: 'pink', type: 'lp', f: sweep(3500, 150, 0.12), q: 0.7, tau: 0.16 }), 0, 0.7);
    // power-down: a falling detuned tone with a closing filter
    const pd = new Mix(1.2);
    pd.add(osc({ type: 'saw', f: glide(440, 55, 0.9), dur: 1.1 }), 0, 0.5);
    pd.add(osc({ type: 'saw', f: glide(446, 54, 0.9), dur: 1.1 }), 0, 0.5);
    m.add(env(lp(pd.out, glide(3000, 180, 0.9), 1.4), ahr(0.01, 0.2, 0.3)), 0.02, 0.35);
    // falling minor-ish bells: the run is over
    [86, 81, 78, 74].forEach((n, i) => m.add(pluck(midi(n - 1), 0.6, { bright: 0.3, tau: 0.25 }), 0.12 + i * 0.13, 0.22));
    m.add(rumble(rng, { dur: 1.4, f: 110, att: 0.01, tau: 0.45 }), 0, 0.5);
    return room(m.out, { wet: 0.2, room: 0.6 });
}
function spawn(rng) {
    const m = new Mix(1.2);
    m.add(whoosh(rng, { dur: 0.42, f0: 250, f1: 4500, q: 1.1, att: 0.36, tau: 0.05 }), 0, 0.55);
    m.add(osc({ f: glide(220, 587, 0.38), dur: 0.42, amp: ahr(0.3, 0.05, 0.05, 2) }), 0, 0.25);
    m.add(thump(160, 55, 0.03, 0.09, 0.4), 0.38, 0.7);
    m.add(bell(midi(86), 1.0, { ratio: 3.01, index: 1.6, tau: 0.45 }), 0.38, 0.35);
    m.add(bell(midi(93), 1.0, { ratio: 3.01, index: 1.2, tau: 0.4 }), 0.4, 0.22);
    m.add(sparkles(rng, { count: 10, spread: 0.35, fLo: 3000, fHi: 8000, tau: 0.03, amp: 0.12, t0: 0.38, tuned: true }));
    return room(m.out, { wet: 0.2 });
}
function dieSmall(rng) {
    const p = rr(rng, 0.9, 1.1), m = new Mix(0.08);
    m.add(osc({ f: sweep(1100 * p, 380 * p, 0.008), dur: 0.06, amp: perc(0.0008, 0.014) }), 0, 0.6);
    m.add(burst(rng, { dur: 0.04, f: 2400 * p, q: 1, tau: 0.006 }), 0, 0.35);
    return m.out;
}
function dieMed(rng) {
    const p = rr(rng, 0.93, 1.07), m = new Mix(0.45);
    m.add(thump(210 * p, 60, 0.02, 0.06, 0.3), 0, 0.9);
    m.add(click(rng, { f: 2200, q: 0.7, tau: 0.0015 }), 0, 0.6);
    m.add(drive(burst(rng, { dur: 0.25, color: 'pink', f: sweep(2500, 400, 0.05), q: 0.8, tau: 0.045 }), 3), 0, 0.6);
    m.add(crumble(rng, { dur: 0.25, count: 22, fLo: 800, fHi: 4000, amp: 0.25, t0: 0.01 }));
    return m.out;
}
function dieLarge(rng) {
    const p = rr(rng, 0.94, 1.06), m = new Mix(1.2);
    m.add(thump(85 * p, 30, 0.06, 0.22, 0.9), 0, 1);
    m.add(click(rng, { f: 1600, q: 0.6, tau: 0.0025, color: 'pink' }), 0, 0.7);
    m.add(drive(burst(rng, { dur: 0.9, color: 'pink', type: 'lp', f: sweep(6000, 180, 0.1), q: 0.7, tau: 0.14 }), 2.2), 0, 0.85);
    m.add(crumble(rng, { dur: 0.7, count: 60, fLo: 600, fHi: 4500, amp: 0.3, t0: 0.02 }));
    m.add(rumble(rng, { dur: 1.0, f: 120, att: 0.01, tau: 0.3 }), 0, 0.55);
    return small(m.out, { wet: 0.15, room: 0.45, tail: 0.5 });
}

// ── mining ─────────────────────────────────────────────────────────────────
function rockHit(rng) { return rockThock(rng, { base: 215, bright: 0.45, weight: 0.8 }); }
function oreHit(rng, tier) {
    const m = new Mix(0.4);
    m.add(rockThock(rng, { base: 190, bright: 0.35, weight: 0.8 }), 0, 0.75);
    m.add(gemTone(tier, rng, { dur: 0.35, len: 0.45 }), 0.004, 0.42 - tier * 0.02);
    return m.out;
}
function rockBreak(rng) { return rockCrunch(rng, { size: 1, crumbles: 75, dur: 0.55 }); }
function oreBreak(rng, tier) {
    const m = new Mix(1.2);
    m.add(rockCrunch(rng, { size: 1, crumbles: 55, dur: 0.45 }), 0, 0.8);
    // the crystal bursting out: tier chime twice (root + octave-ish) + glitter
    m.add(gemTone(tier, rng, { dur: 0.9, len: 1.2 }), 0.02, 0.5);
    const up = { 1: midi(81), 2: midi(88), 3: midi(93), 4: midi(98) }[tier];
    m.add(bell(up, 0.8, { ratio: 3.01, index: 1.2 + tier * 0.2, tau: 0.2 + tier * 0.06 }), 0.07, 0.22);
    m.add(sparkles(rng, { count: 3 + tier * 3, spread: 0.18 + tier * 0.06, fLo: 2500 + tier * 500, fHi: 6000 + tier * 700, tau: 0.028, amp: 0.1 + tier * 0.02, t0: 0.03, tuned: true }));
    return tier >= 3 ? room(m.out, { wet: 0.12 }) : m.out;
}
function rockRegrow(rng) {
    const m = new Mix(0.9);
    const grind = env(bp(noise(0.8, rng, 'brown'), glide(160, 520, 0.6), 1.5), ahr(0.45, 0.1, 0.08, 1.5));
    m.add(grind, 0, 0.9);
    m.add(osc({ f: glide(60, 92, 0.6), dur: 0.75, amp: ahr(0.4, 0.1, 0.08, 1.5) }), 0, 0.4);
    m.add(crumble(rng, { dur: 0.5, count: 18, fLo: 400, fHi: 1600, amp: 0.2, curve: 0.6 }));
    m.add(rockThock(rng, { base: 150, bright: 0 }), 0.6, 0.55);
    return m.out;
}
// Drill/rammer engine: a seamless 2 s loop (tread AM at 11 Hz, 55 Hz motor).
function drillLoop(rng) {
    const L = 2.0, X = 0.35, dur = L + X;
    const m = new Mix(dur);
    const am = (t) => 0.7 + 0.3 * Math.sin(2 * Math.PI * 11 * t);
    m.add(env(lp(osc({ type: 'saw', f: 55, dur }), 420, 1.2), am), 0, 0.5);
    m.add(env(lp(osc({ type: 'square', f: 110, dur }), 700, 0.9), am), 0, 0.14);
    const whine = osc({ f: (t) => 660 + 12 * Math.sin(2 * Math.PI * 1.5 * t), dur });
    m.add(whine, 0, 0.035);
    const grit = env(bp(noise(dur, rng), 950, 1.3), (t) => 0.55 + 0.45 * Math.abs(Math.sin(2 * Math.PI * 5.5 * t)));
    m.add(grit, 0, 0.3);
    m.add(lp(noise(dur, rng, 'brown'), 200, 0.7), 0, 0.35);
    const x = m.out, n = N(L), xn = N(X), out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = x[i];
    for (let i = 0; i < xn; i++) {
        const u = i / xn, a = Math.sin(u * Math.PI / 2), b = Math.cos(u * Math.PI / 2);
        out[i] = x[i] * a + x[n + i] * b;
    }
    return out;
}
function chestLand(rng) {
    const m = new Mix(0.5);
    m.add(thump(130, 50, 0.025, 0.08, 0.35), 0, 1);
    m.add(modal([{ f: 190, a: 1, tau: 0.05 }, { f: 420, a: 0.6, tau: 0.035 }, { f: 745, a: 0.35, tau: 0.02 }], 0.2, 0.0005), 0, 0.5);
    m.add(click(rng, { f: 1500, q: 0.8, tau: 0.002, color: 'pink' }), 0, 0.7);
    // coins rattling inside
    for (let i = 0; i < 6; i++) m.add(modal([{ f: rr(rng, 3000, 5200), a: 1, tau: 0.02 }, { f: rr(rng, 6000, 8000), a: 0.4, tau: 0.01 }], 0.06), 0.03 + rng() * 0.12, 0.08);
    m.add(rumble(rng, { dur: 0.3, f: 200, att: 0.005, tau: 0.08 }), 0, 0.4);
    return m.out;
}
function coins(rng, { count, spread, t0 = 0, amp = 0.12 }) {
    const m = new Mix(t0 + spread + 0.2);
    for (let i = 0; i < count; i++) {
        const f = rr(rng, 2800, 5200);
        m.add(modal([{ f, a: 1, tau: rr(rng, 0.03, 0.08) }, { f: f * 2.71, a: 0.45, tau: 0.025 }, { f: f * 1.51, a: 0.3, tau: 0.03 }], 0.3), t0 + Math.pow(rng(), 1.4) * spread, amp * rr(rng, 0.5, 1));
    }
    return m.out;
}
function chestOpen(rng) {
    const m = new Mix(1.2);
    m.add(drive(burst(rng, { dur: 0.12, f: 1500, q: 0.8, tau: 0.018 }), 2.5), 0, 0.6);
    m.add(modal([{ f: 210, a: 1, tau: 0.06 }, { f: 470, a: 0.6, tau: 0.04 }, { f: 890, a: 0.3, tau: 0.02 }], 0.25), 0, 0.5);
    m.add(thump(150, 55, 0.02, 0.07, 0.3), 0, 0.7);
    m.add(crumble(rng, { dur: 0.2, count: 16, fLo: 700, fHi: 2500, amp: 0.2, t0: 0.01 }));
    m.add(coins(rng, { count: 14, spread: 0.35, t0: 0.05, amp: 0.12 }));
    m.add(pluck(midi(81), 0.6, { bright: 0.5, tau: 0.25 }), 0.12, 0.3);
    m.add(pluck(midi(86), 0.7, { bright: 0.5, tau: 0.3 }), 0.2, 0.3);
    return room(m.out, { wet: 0.14 });
}
function chestOpenEpic(rng) {
    const m = new Mix(2.0);
    m.add(drive(burst(rng, { dur: 0.15, f: 1300, q: 0.7, tau: 0.022 }), 3), 0, 0.6);
    m.add(thump(110, 38, 0.04, 0.13, 0.6), 0, 0.9);
    m.add(crumble(rng, { dur: 0.3, count: 24, fLo: 600, fHi: 2600, amp: 0.22, t0: 0.01 }));
    m.add(coins(rng, { count: 26, spread: 0.6, t0: 0.05, amp: 0.11 }));
    m.add(pad([midi(62), midi(69), midi(74), midi(78)], 1.6, { att: 0.25, hold: 0.3, tau: 0.45, cut: 2200 }), 0.05, 0.3);
    [74, 78, 81, 86, 90, 93].forEach((n, i) => m.add(pluck(midi(n), 0.8, { bright: 0.55, tau: 0.35 }), 0.12 + i * 0.06, 0.24));
    m.add(bell(midi(98), 1.2, { ratio: 3.01, index: 1.4, tau: 0.5 }), 0.5, 0.22);
    m.add(sparkles(rng, { count: 18, spread: 0.7, fLo: 3000, fHi: 8000, tau: 0.035, amp: 0.13, t0: 0.2, tuned: true, rise: 0.5 }));
    return room(m.out, { wet: 0.22, room: 0.65 });
}

// ── gems / satchel ─────────────────────────────────────────────────────────
function gemPickup(rng, tier) {
    const m = new Mix(0.6);
    m.add(gemTone(tier, rng, { dur: 0.55, len: 0.8 + tier * 0.1 }), 0, 1);
    // a soft "pop" underneath so a pickup has body, not just ring
    m.add(osc({ f: sweep(700, 380, 0.01), dur: 0.05, amp: perc(0.001, 0.012) }), 0, 0.25);
    return m.out;
}
function satchelFull(rng) {
    const m = new Mix(0.8);
    // two stuffed-bag thumps with a dull wooden "clunk" that falls: no more room
    [[0, midi(69)], [0.17, midi(62)]].forEach(([at, f]) => {
        m.add(thump(140, 60, 0.02, 0.05, 0.2), at, 0.8);
        m.add(burst(rng, { dur: 0.1, color: 'pink', f: 600, q: 0.9, tau: 0.025 }), at, 0.45);
        m.add(modal([{ f, a: 1, tau: 0.09 }, { f: f * 3.93, a: 0.25, tau: 0.02 }], 0.3, 0.002), at + 0.004, 0.5);
    });
    m.add(coins(rng, { count: 5, spread: 0.2, t0: 0.02, amp: 0.05 }));
    return m.out;
}
function satchelLoss(rng) {
    const m = new Mix(1.6);
    // the haul spilling: chimes scatter DOWN the ladder, then a hollow thud
    [93, 90, 86, 81, 78, 74, 69].forEach((n, i) => {
        const f = midi(n) * rr(rng, 0.995, 1.005);
        m.add(modal([{ f, a: 1, tau: 0.16 }, { f: f * 2.76, a: 0.3, tau: 0.05 }], 0.5), i * 0.055 + rng() * 0.015, 0.25 * (1 - i * 0.07));
    });
    m.add(thump(120, 36, 0.05, 0.18, 0.8), 0.36, 0.9);
    m.add(burst(rng, { dur: 0.5, color: 'pink', type: 'lp', f: sweep(2000, 150, 0.1), q: 0.7, tau: 0.1 }), 0.36, 0.45);
    m.add(osc({ type: 'tri', f: glide(294, 147, 0.5), dur: 0.6, amp: ahr(0.01, 0.1, 0.2) }), 0.38, 0.15);
    return room(m.out, { wet: 0.15 });
}
function heartbeat(rng) {
    const m = new Mix(0.5);
    m.add(thump(72, 42, 0.02, 0.06, 0.25), 0, 1);
    m.add(lp(burst(rng, { dur: 0.08, color: 'brown', type: 'lp', f: 300, q: 0.7, tau: 0.02 }), 400), 0, 0.4);
    m.add(thump(62, 38, 0.02, 0.07, 0.3), 0.15, 0.62);
    return m.out;
}
function dustPop(rng) {
    const m = new Mix(0.3);
    m.add(bell(midi(95), 0.25, { ratio: 3.01, index: 1.1, tau: 0.06 }), 0, 0.5);
    m.add(osc({ f: midi(102), dur: 0.15, amp: perc(0.001, 0.03) }), 0.008, 0.18);
    m.add(sparkles(rng, { count: 3, spread: 0.05, fLo: 5000, fHi: 8000, tau: 0.015, amp: 0.12, t0: 0.01 }));
    return m.out;
}
function dustBank(rng) {
    const m = new Mix(0.8);
    m.add(bell(midi(93), 0.5, { ratio: 3.01, index: 1.2, tau: 0.12 }), 0, 0.45);
    m.add(bell(midi(98), 0.7, { ratio: 3.01, index: 1.2, tau: 0.2 }), 0.08, 0.45);
    m.add(sparkles(rng, { count: 8, spread: 0.25, fLo: 4000, fHi: 8000, tau: 0.025, amp: 0.1, t0: 0.05, tuned: true, rise: 0.3 }));
    return small(m.out, { wet: 0.12 });
}

// ── banking ────────────────────────────────────────────────────────────────
function depositTick(rng) {
    const p = rr(rng, 0.99, 1.01), f = midi(86) * p, m = new Mix(0.14);
    m.add(modal([{ f, a: 1, tau: 0.03 }, { f: f * 2.76, a: 0.35, tau: 0.014 }, { f: f * 5.4, a: 0.12, tau: 0.006 }], 0.12, 0.0006), 0, 0.7);
    m.add(click(rng, { f: 4500, q: 1, tau: 0.0007 }), 0, 0.3);
    return m.out;
}
function depositDone(rng) {
    const m = new Mix(1.3);
    // register clack-clack + the bell chord: "ka-CHING"
    m.add(modal([{ f: 900, a: 1, tau: 0.02 }, { f: 2300, a: 0.5, tau: 0.01 }], 0.08), 0, 0.5);
    m.add(click(rng, { f: 2500, q: 1, tau: 0.0012 }), 0, 0.5);
    m.add(modal([{ f: 1100, a: 1, tau: 0.02 }, { f: 2800, a: 0.5, tau: 0.01 }], 0.08), 0.06, 0.5);
    m.add(thump(160, 60, 0.02, 0.06, 0.25), 0.06, 0.5);
    for (const [n, a] of [[86, 0.4], [90, 0.3], [93, 0.28], [98, 0.14]]) m.add(bell(midi(n), 1.1, { ratio: 3.01, index: 1.5, tau: 0.42 }), 0.08, a);
    m.add(coins(rng, { count: 10, spread: 0.3, t0: 0.08, amp: 0.08 }));
    return room(m.out, { wet: 0.16 });
}
function bankCelebrate(rng) {
    const m = new Mix(2.2);
    m.add(thump(120, 45, 0.03, 0.1, 0.4), 0, 0.6);
    m.add(coins(rng, { count: 40, spread: 0.9, t0: 0, amp: 0.1 }));
    [74, 78, 81, 86, 90, 93].forEach((n, i) => m.add(pluck(midi(n), 0.9, { bright: 0.6, tau: 0.35 }), 0.04 + i * 0.07, 0.3));
    m.add(brass(midi(74), 0.9, { bright: 2400, tau: 0.35, hold: 0.25 }), 0.43, 0.18);
    m.add(brass(midi(81), 0.9, { bright: 2400, tau: 0.35, hold: 0.25 }), 0.43, 0.15);
    m.add(bell(midi(98), 1.4, { ratio: 3.01, index: 1.3, tau: 0.6 }), 0.45, 0.25);
    m.add(sparkles(rng, { count: 16, spread: 0.8, fLo: 3000, fHi: 8000, tau: 0.035, amp: 0.12, t0: 0.35, tuned: true }));
    return room(m.out, { wet: 0.22, room: 0.6 });
}

// ── raid events / storm / boss ─────────────────────────────────────────────
function outpostCapture(rng) {
    const m = new Mix(1.6);
    m.add(thump(120, 40, 0.04, 0.12, 0.5), 0, 0.9);
    m.add(click(rng, { f: 2000, q: 0.7, tau: 0.002 }), 0, 0.6);
    // heraldic horn call: A4 -> D5, with a fifth on top
    m.add(brass(midi(69), 0.35, { tau: 0.1, hold: 0.08, bright: 3000 }), 0.05, 0.35);
    m.add(brass(midi(74), 1.0, { tau: 0.4, hold: 0.3, bright: 3400 }), 0.24, 0.35);
    m.add(brass(midi(81), 1.0, { tau: 0.4, hold: 0.3, bright: 3400 }), 0.24, 0.25);
    m.add(bell(midi(86), 1.1, { ratio: 3.01, index: 1.5, tau: 0.45 }), 0.26, 0.25);
    return room(m.out, { wet: 0.22 });
}
function chamberOpen(rng) {
    const m = new Mix(2.2);
    m.add(env(bp(noise(0.9, rng, 'brown'), glide(120, 380, 0.7), 1.3), ahr(0.4, 0.2, 0.15, 1.5)), 0, 0.9);
    m.add(crumble(rng, { dur: 0.7, count: 40, fLo: 400, fHi: 2000, amp: 0.2, curve: 0.8 }));
    m.add(thump(110, 38, 0.04, 0.14, 0.6), 0.62, 0.9);
    m.add(pad([midi(62), midi(69), midi(74), midi(78)], 1.4, { att: 0.3, hold: 0.2, tau: 0.4, cut: 2400 }), 0.55, 0.3);
    [74, 81, 86, 90, 93].forEach((n, i) => m.add(gemTone(i < 2 ? 2 : i < 4 ? 3 : 4, rng, { dur: 0.9, len: 1.2 }), 0.62 + i * 0.07, 0.2));
    m.add(sparkles(rng, { count: 16, spread: 0.7, fLo: 3000, fHi: 8000, tau: 0.035, amp: 0.12, t0: 0.66, tuned: true }));
    return room(m.out, { wet: 0.24, room: 0.65 });
}
function bossSurface(rng) {
    const m = new Mix(2.4);
    m.add(thump(70, 28, 0.08, 0.3, 1.2), 0, 1);
    m.add(rumble(rng, { dur: 2.0, f: 110, att: 0.05, hold: 0.5, tau: 0.5 }), 0, 0.8);
    // the roar: growling FM + distorted saw with vibrato, lowpassed so it is
    // huge instead of harsh
    const pitch = (t) => (t < 0.35 ? 48 + 30 * (t / 0.35) : 78 * Math.exp(-(t - 0.35) / 1.4)) * (1 + 0.04 * Math.sin(2 * Math.PI * 6 * t));
    const growl = fm({ f: pitch, ratio: 0.5, index: (t) => 3 + 2 * Math.sin(2 * Math.PI * 3 * t), dur: 1.8 });
    const saw = osc({ type: 'saw', f: (t) => pitch(t) * 2.01, dur: 1.8 });
    const g = new Float32Array(growl.length);
    for (let i = 0; i < g.length; i++) g[i] = growl[i] * 0.6 + saw[i] * 0.5;
    m.add(env(lp(drive(g, 3), (t) => 500 + 900 * Math.exp(-Math.abs(t - 0.4) / 0.3), 1.3), ahr(0.18, 0.5, 0.45, 1.5)), 0.05, 0.6);
    m.add(whoosh(rng, { dur: 1.2, f0: 300, f1: 900, q: 1.2, att: 0.3, tau: 0.4, color: 'brown' }), 0.05, 0.4);
    return room(m.out, { wet: 0.25, room: 0.7, tail: 1.4 });
}
function bossDefeat(rng) {
    const m = new Mix(3.0);
    m.add(dieLarge(rng), 0, 0.9);
    m.add(crumble(rng, { dur: 0.9, count: 70, fLo: 600, fHi: 5000, amp: 0.25, t0: 0.05 }));
    [62, 66, 69, 74].forEach((n, i) => m.add(brass(midi(n), 0.4, { bright: 3200, tau: 0.12, hold: 0.05 }), 0.35 + i * 0.09, 0.3));
    for (const n of [74, 78, 81]) m.add(brass(midi(n), 1.5, { bright: 3400, tau: 0.6, hold: 0.45 }), 0.72, 0.22);
    m.add(bell(midi(86), 1.8, { ratio: 3.01, index: 1.6, tau: 0.7 }), 0.72, 0.3);
    m.add(sparkles(rng, { count: 24, spread: 1.0, fLo: 3000, fHi: 8000, tau: 0.035, amp: 0.12, t0: 0.72, tuned: true }));
    return room(m.out, { wet: 0.24, room: 0.7, tail: 1.4 });
}
function stormWarning(rng) {
    const m = new Mix(2.0);
    m.add(whoosh(rng, { dur: 1.7, f0: 250, f1: 1600, q: 0.9, att: 1.2, tau: 0.3, color: 'pink' }), 0, 0.6);
    // ominous tritone drone swelling (D + G#), with slow beating
    for (const [f, a] of [[midi(50), 0.5], [midi(56), 0.35], [midi(62), 0.25]]) {
        m.add(lp(osc({ type: 'saw', f: (t) => f * (1 + 0.003 * Math.sin(2 * Math.PI * 0.7 * t)), dur: 1.8, amp: ahr(1.1, 0.2, 0.3, 1.6) }), 900), 0, a * 0.5);
    }
    m.add(thump(90, 40, 0.05, 0.2, 0.6), 1.25, 0.6);
    return room(m.out, { wet: 0.25, room: 0.7 });
}
function stormShrink(rng) {
    const m = new Mix(2.4);
    m.add(whoosh(rng, { dur: 1.6, f0: 2500, f1: 180, q: 0.9, att: 0.25, tau: 0.5, color: 'pink' }), 0, 0.7);
    m.add(thump(75, 30, 0.08, 0.3, 1.0), 0.1, 0.8);
    // thunder: brown noise bursts crackling and rolling off
    for (let i = 0; i < 7; i++) {
        const at = 0.1 + Math.pow(rng(), 1.3) * 0.9;
        m.add(burst(rng, { dur: 0.6, color: 'brown', type: 'lp', f: rr(rng, 300, 900), q: 0.7, att: 0.004, tau: rr(rng, 0.08, 0.25) }), at, rr(rng, 0.3, 0.6));
    }
    m.add(crumble(rng, { dur: 0.6, count: 30, fLo: 1500, fHi: 5000, amp: 0.12, t0: 0.1 }));
    return room(m.out, { wet: 0.25, room: 0.75, tail: 1.3 });
}
function stormFinal(rng) {
    const m = new Mix(2.8);
    m.add(thump(65, 26, 0.08, 0.35, 1.3), 0, 1);
    m.add(drive(burst(rng, { dur: 1.2, color: 'pink', type: 'lp', f: sweep(5000, 200, 0.15), q: 0.7, tau: 0.25 }), 2), 0, 0.7);
    // dissonant brass stab: D minor with a flat-second rub
    for (const n of [50, 57, 62, 63, 65]) m.add(brass(midi(n), 1.4, { bright: 2600, tau: 0.5, hold: 0.35, att: 0.012 }), 0.01, 0.16);
    m.add(rumble(rng, { dur: 2.2, f: 100, att: 0.05, hold: 0.6, tau: 0.6 }), 0, 0.7);
    return room(m.out, { wet: 0.25, room: 0.75, tail: 1.4 });
}
function stormEnter(rng) {
    const m = new Mix(0.6);
    // electric crackle: sparse HP snaps over a gated 100 Hz buzz
    for (let i = 0; i < 14; i++) m.add(click(rng, { f: rr(rng, 3000, 7000), q: 0.8, tau: rr(rng, 0.0006, 0.002) }), Math.pow(rng(), 1.5) * 0.45, rr(rng, 0.3, 0.8));
    const buzz = env(bp(osc({ type: 'saw', f: 100, dur: 0.5 }), 900, 1.5), (t) => perc(0.005, 0.12)(t) * (0.6 + 0.4 * (Math.sin(2 * Math.PI * 30 * t) > 0 ? 1 : 0)));
    m.add(buzz, 0, 0.45);
    m.add(thump(120, 50, 0.02, 0.06, 0.2), 0, 0.5);
    return m.out;
}
function stormExit(rng) {
    const m = new Mix(0.6);
    m.add(whoosh(rng, { dur: 0.45, f0: 600, f1: 2200, q: 1.1, att: 0.12, tau: 0.1 }), 0, 0.6);
    m.add(osc({ f: glide(midi(74), midi(81), 0.12), dur: 0.35, amp: ahr(0.03, 0.05, 0.1) }), 0.05, 0.2);
    return small(m.out, { wet: 0.12 });
}
function raidTwist(rng) {
    const m = new Mix(1.6);
    m.add(whoosh(rng, { dur: 0.5, f0: 300, f1: 5000, q: 1.2, att: 0.4, tau: 0.05 }), 0, 0.5);
    // glitchy stuttered arpeggio — the rules just changed
    const arp = new Mix(0.6);
    [74, 81, 86, 81, 90, 86, 93].forEach((n, i) => arp.add(osc({ type: 'square', f: midi(n), dur: 0.07, amp: perc(0.001, 0.03) }), i * 0.05, 0.3));
    m.add(lp(crush(arp.out, 3, 7), 5000), 0.05, 0.5);
    m.add(thump(130, 45, 0.03, 0.1, 0.4), 0.42, 0.8);
    m.add(bell(midi(86), 1.0, { ratio: 1.41, index: 2.4, tau: 0.45 }), 0.42, 0.35);
    m.add(bell(midi(92), 1.0, { ratio: 1.41, index: 1.8, tau: 0.4 }), 0.44, 0.2);
    m.add(sparkles(rng, { count: 8, spread: 0.3, fLo: 3000, fHi: 8000, tau: 0.03, amp: 0.1, t0: 0.44 }));
    return room(m.out, { wet: 0.22 });
}
function raidStart(rng) {
    const m = new Mix(2.0);
    m.add(whoosh(rng, { dur: 0.35, f0: 300, f1: 4000, q: 1.1, att: 0.3, tau: 0.04 }), 0, 0.45);
    m.add(thump(110, 36, 0.05, 0.16, 0.6), 0.3, 1);
    m.add(click(rng, { f: 2200, q: 0.7, tau: 0.002 }), 0.3, 0.6);
    for (const n of [62, 69, 74, 78]) m.add(brass(midi(n), 1.3, { bright: 3600, tau: 0.5, hold: 0.3, att: 0.015 }), 0.3, 0.2);
    m.add(bell(midi(86), 1.3, { ratio: 3.01, index: 1.6, tau: 0.5 }), 0.3, 0.3);
    m.add(sparkles(rng, { count: 10, spread: 0.4, fLo: 3000, fHi: 8000, tau: 0.03, amp: 0.1, t0: 0.32, tuned: true, rise: 0.4 }));
    return room(m.out, { wet: 0.22, room: 0.65 });
}
function raidEnd(rng) {
    const m = new Mix(3.2);
    m.add(thump(100, 36, 0.05, 0.16, 0.6), 0, 0.8);
    [74, 78, 81, 86].forEach((n, i) => m.add(pluck(midi(n), 1.0, { bright: 0.5, tau: 0.4 }), i * 0.09, 0.28));
    m.add(pad([midi(62), midi(66), midi(69), midi(74), midi(78)], 2.6, { att: 0.35, hold: 0.9, tau: 0.8, cut: 2200 }), 0.3, 0.4);
    for (const n of [74, 81, 86]) m.add(brass(midi(n), 2.0, { bright: 3000, tau: 0.8, hold: 0.7, att: 0.05 }), 0.36, 0.14);
    m.add(bell(midi(98), 2.0, { ratio: 3.01, index: 1.4, tau: 0.8 }), 0.4, 0.22);
    m.add(coins(rng, { count: 26, spread: 1.0, t0: 0.4, amp: 0.07 }));
    m.add(sparkles(rng, { count: 20, spread: 1.4, fLo: 3000, fHi: 8000, tau: 0.035, amp: 0.1, t0: 0.4, tuned: true }));
    return room(m.out, { wet: 0.26, room: 0.72, tail: 1.5 });
}
function countTick(rng) {
    const m = new Mix(0.3);
    m.add(osc({ f: midi(81), dur: 0.2, amp: perc(0.001, 0.05) }), 0, 0.6);
    m.add(osc({ f: midi(93), dur: 0.1, amp: perc(0.001, 0.015) }), 0, 0.15);
    m.add(click(rng, { f: 3500, q: 1, tau: 0.0008 }), 0, 0.35);
    m.add(thump(200, 100, 0.01, 0.02, 0.08), 0, 0.3);
    return m.out;
}
function countGo(rng) {
    const m = new Mix(0.7);
    for (const [n, a] of [[86, 0.5], [93, 0.3], [98, 0.18]]) m.add(osc({ f: midi(n), dur: 0.6, amp: perc(0.001, 0.14) }), 0, a);
    m.add(click(rng, { f: 3500, q: 1, tau: 0.001 }), 0, 0.4);
    m.add(thump(160, 60, 0.02, 0.06, 0.25), 0, 0.5);
    return small(m.out, { wet: 0.15 });
}
function bloomStart(rng) {
    const m = new Mix(2.2);
    m.add(pad([midi(62), midi(69), midi(74), midi(76)], 1.8, { att: 0.5, hold: 0.3, tau: 0.5, cut: 2600 }), 0, 0.35);
    for (let i = 0; i < 12; i++) m.add(gemTone(i < 4 ? 2 : i < 8 ? 3 : 4, rng, { dur: 0.7, len: 0.9 }), 0.05 + i * 0.07, 0.14);
    m.add(whoosh(rng, { dur: 1.0, f0: 800, f1: 6000, q: 1, att: 0.7, tau: 0.2 }), 0, 0.2);
    return room(m.out, { wet: 0.26, room: 0.7 });
}
function meteorWarn(rng) {
    const m = new Mix(1.7);
    m.add(osc({ f: (t) => glide(2400, 520, 1.3)(t) * (1 + 0.01 * Math.sin(2 * Math.PI * 7 * t)), dur: 1.4, amp: ahr(0.15, 0.9, 0.25) }), 0, 0.3);
    m.add(whoosh(rng, { dur: 1.4, f0: 3000, f1: 500, q: 1.3, att: 0.6, tau: 0.3 }), 0, 0.4);
    m.add(rumble(rng, { dur: 1.4, f: 120, att: 0.9, hold: 0.1, tau: 0.3 }), 0, 0.5);
    return room(m.out, { wet: 0.2 });
}
function meteorImpact(rng) {
    const m = new Mix(1.5);
    m.add(dieLarge(rng), 0, 0.85);
    m.add(rockCrunch(rng, { size: 1.3, crumbles: 60, dur: 0.7 }), 0.01, 0.6);
    return m.out;
}
function gemRain(rng) {
    const m = new Mix(2.2);
    for (let i = 0; i < 22; i++) {
        const tier = 1 + Math.floor(rng() * 4);
        m.add(gemTone(tier, rng, { dur: 0.5, len: 0.6 }), Math.pow(i / 21, 0.85) * 1.3 + rng() * 0.05, 0.12);
    }
    m.add(whoosh(rng, { dur: 1.5, f0: 4000, f1: 1500, q: 0.9, att: 0.3, tau: 0.5 }), 0, 0.15);
    return room(m.out, { wet: 0.24, room: 0.7 });
}
function questComplete(rng) {
    const m = new Mix(1.2);
    m.add(osc({ f: sweep(900, 600, 0.01), dur: 0.06, amp: perc(0.001, 0.015) }), 0, 0.35);
    [74, 81, 86].forEach((n, i) => m.add(pluck(midi(n), 0.7, { bright: 0.55, tau: 0.3 }), 0.02 + i * 0.08, 0.35));
    m.add(bell(midi(93), 0.9, { ratio: 3.01, index: 1.2, tau: 0.35 }), 0.2, 0.2);
    m.add(sparkles(rng, { count: 7, spread: 0.3, fLo: 3500, fHi: 8000, tau: 0.03, amp: 0.1, t0: 0.2, tuned: true, rise: 0.3 }));
    return room(m.out, { wet: 0.18 });
}
function milestone(rng) {
    const m = new Mix(1.8);
    m.add(thump(120, 44, 0.03, 0.1, 0.4), 0, 0.7);
    // "ta-DAA": short brass pickup into a held major chord
    for (const n of [69, 74]) m.add(brass(midi(n), 0.2, { bright: 3200, tau: 0.06, hold: 0.04 }), 0.02, 0.25);
    for (const n of [74, 78, 81, 86]) m.add(brass(midi(n), 1.2, { bright: 3400, tau: 0.45, hold: 0.3 }), 0.17, 0.17);
    m.add(coins(rng, { count: 14, spread: 0.5, t0: 0.17, amp: 0.08 }));
    m.add(sparkles(rng, { count: 10, spread: 0.5, fLo: 3000, fHi: 8000, tau: 0.035, amp: 0.1, t0: 0.2, tuned: true }));
    return room(m.out, { wet: 0.22 });
}
function placeUp(rng) {
    const m = new Mix(0.6);
    m.add(pluck(midi(81), 0.4, { bright: 0.6, tau: 0.14 }), 0, 0.4);
    m.add(pluck(midi(86), 0.5, { bright: 0.6, tau: 0.22 }), 0.07, 0.45);
    m.add(sparkles(rng, { count: 4, spread: 0.12, fLo: 4000, fHi: 8000, tau: 0.02, amp: 0.1, t0: 0.08, tuned: true }));
    return small(m.out, { wet: 0.12 });
}
function placeDown(rng) {
    const m = new Mix(0.6);
    m.add(lp(pluck(midi(74), 0.4, { bright: 0.3, tau: 0.16 }), 2500), 0, 0.4);
    m.add(lp(pluck(midi(69), 0.5, { bright: 0.3, tau: 0.22 }), 2000), 0.1, 0.4);
    return small(m.out, { wet: 0.1 });
}

// ── progression ────────────────────────────────────────────────────────────
function levelUp(rng) {
    const m = new Mix(1.2);
    [74, 78, 81, 86, 90].forEach((n, i) => m.add(pluck(midi(n), 0.6, { bright: 0.6, tau: 0.25 }), i * 0.05, 0.3));
    m.add(osc({ f: glide(midi(74), midi(98), 0.22), dur: 0.3, amp: ahr(0.02, 0.12, 0.08) }), 0, 0.12);
    m.add(bell(midi(98), 0.9, { ratio: 3.01, index: 1.2, tau: 0.35 }), 0.24, 0.2);
    m.add(sparkles(rng, { count: 10, spread: 0.35, fLo: 3500, fHi: 8000, tau: 0.03, amp: 0.1, t0: 0.15, tuned: true, rise: 0.4 }));
    return room(m.out, { wet: 0.18 });
}
function statUp(rng, v) {
    const p = [1, 1.06, 1.12][v % 3], m = new Mix(0.16);
    m.add(fm({ f: glide(520 * p, 980 * p, 0.05), ratio: 2, index: (t) => 0.8 * Math.exp(-t / 0.02), dur: 0.12, amp: perc(0.001, 0.03) }), 0, 0.55);
    m.add(osc({ f: 1960 * p, dur: 0.06, amp: perc(0.001, 0.012) }), 0.02, 0.12);
    return m.out;
}
function tankUpgrade(rng) {
    const m = new Mix(1.3);
    // servo whir up -> clamp CLUNK -> power chord shimmer: you transformed
    m.add(env(bp(osc({ type: 'saw', f: glide(180, 760, 0.3), dur: 0.34 }), glide(500, 2400, 0.3), 2), ahr(0.08, 0.2, 0.03)), 0, 0.35);
    m.add(whoosh(rng, { dur: 0.3, f0: 500, f1: 3000, q: 1.3, att: 0.25, tau: 0.03 }), 0, 0.3);
    m.add(modal([{ f: 310, a: 1, tau: 0.08 }, { f: 820, a: 0.6, tau: 0.05 }, { f: 1530, a: 0.4, tau: 0.03 }, { f: 2710, a: 0.2, tau: 0.02 }], 0.3, 0.0004), 0.3, 0.45);
    m.add(thump(140, 45, 0.03, 0.1, 0.4), 0.3, 0.9);
    m.add(click(rng, { f: 2400, q: 0.7, tau: 0.0015 }), 0.3, 0.6);
    for (const n of [62, 69, 74]) m.add(brass(midi(n), 0.8, { bright: 3000, tau: 0.3, hold: 0.1 }), 0.32, 0.18);
    m.add(sparkles(rng, { count: 8, spread: 0.3, fLo: 3000, fHi: 8000, tau: 0.03, amp: 0.1, t0: 0.34, tuned: true }));
    return room(m.out, { wet: 0.18 });
}
function shopBuy(rng) {
    const m = new Mix(0.9);
    m.add(modal([{ f: 1000, a: 1, tau: 0.02 }, { f: 2500, a: 0.5, tau: 0.01 }], 0.08), 0, 0.4);
    m.add(click(rng, { f: 2600, q: 1, tau: 0.001 }), 0, 0.4);
    m.add(coins(rng, { count: 8, spread: 0.18, t0: 0.02, amp: 0.12 }));
    m.add(bell(midi(90), 0.8, { ratio: 3.01, index: 1.4, tau: 0.3 }), 0.05, 0.35);
    m.add(bell(midi(93), 0.8, { ratio: 3.01, index: 1.4, tau: 0.32 }), 0.1, 0.3);
    return small(m.out, { wet: 0.14 });
}
function shopDenied(rng) {
    const m = new Mix(0.45);
    for (const [at, f] of [[0, 196], [0.11, 175]]) {
        m.add(lp(osc({ type: 'square', f, dur: 0.12, amp: ahr(0.004, 0.04, 0.03) }), 1100, 0.8), at, 0.3);
        m.add(osc({ type: 'tri', f: f / 2, dur: 0.12, amp: ahr(0.004, 0.04, 0.03) }), at, 0.35);
    }
    return m.out;
}

// ── rank ceremony ──────────────────────────────────────────────────────────
function rankCrack(rng, stage) {
    const m = new Mix(0.45);
    m.add(click(rng, { f: 4500 + stage * 700, q: 0.6, tau: 0.001 }), 0, 0.9);
    const modes = [];
    for (let i = 0; i < 6; i++) modes.push({ f: rr(rng, 1800, 3500) * (1 + stage * 0.25), a: rr(rng, 0.3, 0.8), tau: rr(rng, 0.02, 0.06) });
    m.add(modal(modes, 0.3, 0.0003), 0, 0.35 + stage * 0.05);
    m.add(thump(200 + stage * 30, 90, 0.012, 0.03, 0.15), 0, 0.5);
    m.add(burst(rng, { dur: 0.08, type: 'hp', f: 3000, q: 0.7, tau: 0.01 }), 0, 0.3);
    return small(m.out, { wet: 0.15 });
}
function rankShatter(rng) {
    const m = new Mix(1.4);
    m.add(thump(110, 38, 0.04, 0.13, 0.5), 0, 0.9);
    m.add(click(rng, { f: 5500, q: 0.6, tau: 0.0012 }), 0, 0.9);
    m.add(burst(rng, { dur: 0.4, type: 'hp', f: sweep(6000, 2500, 0.1), q: 0.6, tau: 0.06 }), 0, 0.45);
    for (let i = 0; i < 26; i++) {
        const f = rr(rng, 2000, 7500);
        m.add(modal([{ f, a: 1, tau: rr(rng, 0.02, 0.07) }, { f: f * 2.4, a: 0.4, tau: 0.015 }], 0.25), 0.02 + Math.pow(rng(), 1.6) * 0.8, rr(rng, 0.05, 0.14));
    }
    return room(m.out, { wet: 0.22 });
}
function rankUp(rng, big) {
    const m = new Mix(big ? 3.2 : 2.3);
    m.add(thump(110, 36, 0.05, 0.16, 0.6), 0, 0.9);
    const notes = big ? [62, 66, 69, 74, 78, 81, 86] : [62, 66, 69, 74, 78];
    notes.forEach((n, i) => m.add(pluck(midi(n + 12), 0.9, { bright: 0.55, tau: 0.35 }), 0.04 + i * 0.065, 0.26));
    const at = 0.04 + notes.length * 0.065;
    const chord = big ? [62, 69, 74, 78, 81] : [62, 69, 74, 78];
    for (const n of chord) m.add(brass(midi(n), big ? 2.0 : 1.4, { bright: 3400, tau: big ? 0.8 : 0.55, hold: big ? 0.6 : 0.35 }), at, 0.14);
    if (big) m.add(pad([midi(50), midi(62), midi(69), midi(74)], 2.4, { att: 0.3, hold: 0.9, tau: 0.8, cut: 1800 }), at - 0.05, 0.3);
    m.add(bell(midi(big ? 98 : 93), 1.6, { ratio: 3.01, index: 1.5, tau: big ? 0.8 : 0.6 }), at, 0.26);
    m.add(sparkles(rng, { count: big ? 26 : 14, spread: big ? 1.2 : 0.7, fLo: 3000, fHi: 8000, tau: 0.035, amp: 0.11, t0: at, tuned: true }));
    return room(m.out, { wet: 0.25, room: 0.7, tail: 1.5 });
}
function rankDown(rng) {
    const m = new Mix(0.8);
    m.add(lp(pluck(midi(69), 0.5, { bright: 0.35, tau: 0.2 }), 2600), 0, 0.4);
    m.add(lp(pluck(midi(66), 0.6, { bright: 0.35, tau: 0.28 }), 2200), 0.13, 0.4);
    return small(m.out, { wet: 0.14 });
}

// ── UI ─────────────────────────────────────────────────────────────────────
// Bubbly, rounded, short. Sine pops with a 1 ms attack: crisp but soft.
function uiClick(rng, v) {
    const p = [1, 1.04, 0.96][v % 3], m = new Mix(0.08);
    m.add(osc({ f: sweep(1500 * p, 780 * p, 0.006), dur: 0.05, amp: perc(0.0008, 0.012) }), 0, 0.7);
    m.add(click(rng, { f: 4200, q: 1.2, tau: 0.0005 }), 0, 0.12);
    return m.out;
}
function uiHover(rng) { return osc({ f: 2350, dur: 0.03, amp: perc(0.001, 0.006) }); }
function uiTab(rng) {
    const m = new Mix(0.1);
    m.add(osc({ f: sweep(1000, 560, 0.008), dur: 0.07, amp: perc(0.001, 0.018) }), 0, 0.7);
    m.add(osc({ f: 1680, dur: 0.04, amp: perc(0.001, 0.008) }), 0.004, 0.12);
    return m.out;
}
function uiToggle(rng, on) {
    const m = new Mix(0.14);
    const [a, b] = on ? [880, 1320] : [1320, 880];
    m.add(osc({ f: a, dur: 0.05, amp: perc(0.001, 0.01) }), 0, 0.5);
    m.add(osc({ f: b, dur: 0.07, amp: perc(0.001, 0.016) }), 0.045, 0.55);
    return m.out;
}
function uiPlay(rng) {
    const m = new Mix(1.0);
    m.add(osc({ f: sweep(1200, 600, 0.01), dur: 0.06, amp: perc(0.001, 0.015) }), 0, 0.4);
    m.add(whoosh(rng, { dur: 0.3, f0: 400, f1: 3500, q: 1.1, att: 0.2, tau: 0.05 }), 0, 0.3);
    m.add(thump(150, 55, 0.02, 0.07, 0.3), 0.18, 0.6);
    for (const [n, a] of [[74, 0.3], [81, 0.28], [86, 0.3]]) m.add(pluck(midi(n), 0.7, { bright: 0.5, tau: 0.3 }), 0.18, a);
    m.add(sparkles(rng, { count: 6, spread: 0.25, fLo: 3500, fHi: 8000, tau: 0.03, amp: 0.1, t0: 0.2, tuned: true, rise: 0.3 }));
    return room(m.out, { wet: 0.15 });
}
function uiSuccess(rng) {
    const m = new Mix(0.5);
    m.add(bell(midi(81), 0.35, { ratio: 3.01, index: 0.9, tau: 0.1 }), 0, 0.4);
    m.add(bell(midi(86), 0.45, { ratio: 3.01, index: 0.9, tau: 0.16 }), 0.07, 0.4);
    return m.out;
}
function uiError(rng) {
    const m = new Mix(0.35);
    for (const [at, f] of [[0, 233], [0.1, 220]]) {
        m.add(lp(osc({ type: 'tri', f, dur: 0.1, amp: ahr(0.003, 0.035, 0.02) }), 1800), at, 0.45);
        m.add(lp(osc({ type: 'tri', f: f * 1.012, dur: 0.1, amp: ahr(0.003, 0.035, 0.02) }), 1800), at, 0.3);
    }
    return m.out;
}
function notify(rng) {
    const m = new Mix(0.9);
    m.add(bell(midi(90), 0.6, { ratio: 3.01, index: 1.1, tau: 0.22 }), 0, 0.4);
    m.add(bell(midi(86), 0.8, { ratio: 3.01, index: 1.1, tau: 0.3 }), 0.13, 0.4);
    return small(m.out, { wet: 0.14 });
}

// ── registry ───────────────────────────────────────────────────────────────
// target: loudest-100ms loudness (LUFS-ish) each file is normalised to. The
// runtime then only does gentle per-event mixing on top of consistent assets.
const T = { gun: -12, hit: -13, world: -12, gem: -14, ui: -19, sting: -13, alert: -14, loop: -18 };
const S = [];
const add = (family, name, n, target, fn, stereo = false) => S.push({ family, name, n, target, fn, stereo });

add('weapons', 'shot_light', 4, T.gun, shotLight);
add('weapons', 'shot_mg', 4, T.gun, shotMG);
add('weapons', 'shot_cannon', 3, T.gun, shotCannon);
add('weapons', 'shot_sniper', 3, T.gun, shotSniper);
add('weapons', 'shot_trap', 3, T.gun, shotTrap);
add('weapons', 'drone_launch', 3, T.gun - 1, droneLaunch);

add('combat', 'hit_t0', 3, T.hit, (r) => hitDealt(r, 0));
add('combat', 'hit_t1', 2, T.hit, (r) => hitDealt(r, 1));
add('combat', 'hit_t2', 2, T.hit, (r) => hitDealt(r, 2));
add('combat', 'hurt_light', 3, T.hit, (r) => hurt(r, false));
add('combat', 'hurt_heavy', 2, T.hit + 1, (r) => hurt(r, true));
add('combat', 'kill', 2, T.sting, kill, true);
add('combat', 'streak', 1, T.sting, streak, true);
add('combat', 'shutdown', 1, T.sting, shutdown, true);
add('combat', 'revenge', 1, T.sting, revenge, true);
add('combat', 'low_health', 1, T.alert, lowHealth);
add('combat', 'shield_up', 1, T.alert, shieldUp, true);
add('combat', 'shield_break', 1, T.alert, shieldBreak);
add('combat', 'death', 1, T.sting, playerDeath, true);
add('combat', 'spawn', 1, T.sting, spawn, true);
add('combat', 'die_small', 3, T.world - 4, dieSmall);
add('combat', 'die_med', 2, T.world, dieMed);
add('combat', 'die_large', 2, T.world, dieLarge);

add('mining', 'rock_hit', 4, T.world, rockHit);
for (let t = 1; t <= 4; t++) add('mining', 'ore_hit_t' + t, 2, T.world, (r) => oreHit(r, t));
add('mining', 'rock_break', 3, T.world, rockBreak);
for (let t = 1; t <= 4; t++) add('mining', 'ore_break_t' + t, 1, T.world, (r) => oreBreak(r, t), t >= 3);
add('mining', 'rock_regrow', 2, T.world - 3, rockRegrow);
add('mining', 'chest_land', 1, T.world, chestLand);
add('mining', 'chest_open', 1, T.sting, chestOpen, true);
add('mining', 'chest_open_epic', 1, T.sting, chestOpenEpic, true);
add('loops', 'drill_loop', 1, T.loop, drillLoop);

for (let t = 1; t <= 4; t++) add('gems', 'gem_t' + t, 2, T.gem, (r) => gemPickup(r, t));
add('gems', 'satchel_full', 1, T.alert, satchelFull);
add('gems', 'satchel_loss', 1, T.sting, satchelLoss, true);
add('gems', 'heartbeat', 1, T.alert - 2, heartbeat);
add('gems', 'dust_pop', 1, T.gem - 2, dustPop);
add('gems', 'dust_bank', 1, T.gem, dustBank);

add('bank', 'deposit_tick', 3, T.gem - 2, depositTick);
add('bank', 'deposit_done', 1, T.sting, depositDone, true);
add('bank', 'bank_celebrate', 1, T.sting, bankCelebrate, true);

add('events', 'outpost_capture', 1, T.sting, outpostCapture, true);
add('events', 'chamber_open', 1, T.sting, chamberOpen, true);
add('events', 'boss_surface', 1, T.sting, bossSurface, true);
add('events', 'boss_defeat', 1, T.sting, bossDefeat, true);
add('events', 'storm_warning', 1, T.alert, stormWarning, true);
add('events', 'storm_shrink', 1, T.alert, stormShrink, true);
add('events', 'storm_final', 1, T.sting, stormFinal, true);
add('events', 'storm_enter', 1, T.alert, stormEnter);
add('events', 'storm_exit', 1, T.alert - 2, stormExit);
add('events', 'raid_twist', 1, T.sting, raidTwist, true);
add('events', 'raid_start', 1, T.sting, raidStart, true);
add('events', 'raid_end', 1, T.sting, raidEnd, true);
add('events', 'count_tick', 1, T.alert, countTick);
add('events', 'count_go', 1, T.alert, countGo);
add('events', 'bloom_start', 1, T.sting, bloomStart, true);
add('events', 'meteor_warn', 1, T.alert, meteorWarn, true);
add('events', 'meteor_impact', 1, T.world, meteorImpact);
add('events', 'gem_rain', 1, T.sting, gemRain, true);
add('events', 'quest_complete', 1, T.sting, questComplete, true);
add('events', 'milestone', 1, T.sting, milestone, true);
add('events', 'place_up', 1, T.alert, placeUp);
add('events', 'place_down', 1, T.alert - 2, placeDown);

add('progress', 'level_up', 1, T.sting, levelUp, true);
add('progress', 'stat_up', 3, T.ui + 3, statUp);
add('progress', 'tank_upgrade', 1, T.sting, tankUpgrade, true);
add('progress', 'shop_buy', 1, T.alert, shopBuy);
add('progress', 'shop_denied', 1, T.ui + 2, shopDenied);

add('rank', 'rank_crack1', 1, T.alert, (r) => rankCrack(r, 1));
add('rank', 'rank_crack2', 1, T.alert, (r) => rankCrack(r, 2));
add('rank', 'rank_crack3', 1, T.alert, (r) => rankCrack(r, 3));
add('rank', 'rank_shatter', 1, T.sting, rankShatter, true);
add('rank', 'rank_up', 1, T.sting, (r) => rankUp(r, false), true);
add('rank', 'rank_up_big', 1, T.sting, (r) => rankUp(r, true), true);
add('rank', 'rank_down', 1, T.alert - 2, rankDown);

add('ui', 'ui_click', 3, T.ui, uiClick);
add('ui', 'ui_hover', 1, T.ui - 8, uiHover);
add('ui', 'ui_tab', 1, T.ui, uiTab);
add('ui', 'ui_toggle_on', 1, T.ui, (r) => uiToggle(r, true));
add('ui', 'ui_toggle_off', 1, T.ui, (r) => uiToggle(r, false));
add('ui', 'ui_play', 1, T.alert, uiPlay, true);
add('ui', 'ui_success', 1, T.ui + 2, uiSuccess);
add('ui', 'ui_error', 1, T.ui + 2, uiError);
add('ui', 'notify', 1, T.ui + 3, notify);

module.exports = { SOUNDS: S, LOOPS: { drill_loop: 2.0 } };
