import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const SR = 48000;
const DUR = 24.6;
const N = Math.ceil(SR * DUR);
const BEAT = 0.5;

const mus = [new Float32Array(N), new Float32Array(N)];
const verb = [new Float32Array(N), new Float32Array(N)];
const sfx = [new Float32Array(N), new Float32Array(N)];

let seed = 12345;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const noise = () => rnd() * 2 - 1;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const midi = m => 440 * Math.pow(2, (m - 69) / 12);
const blep = (t, dt) => {
    if (t < dt) { t /= dt; return t + t - t * t - 1; }
    if (t > 1 - dt) { t = (t - 1) / dt; return t * t + t + t + 1; }
    return 0;
};

function add(bus, i, l, r) { if (i >= 0 && i < N) { bus[0][i] += l; bus[1][i] += r; } }

function lp1(cut) { const a = 1 - Math.exp(-2 * Math.PI * cut / SR); let y = 0; return x => (y += a * (x - y)); }

function synthNote(t0, dur, freq, o = {}) {
    const voices = o.voices ?? 3, det = o.detune ?? 0.12;
    const att = o.att ?? 0.01, rel = o.rel ?? 0.2, dec = o.dec ?? 0;
    const gain = o.gain ?? 0.1, pan = o.pan ?? 0;
    const i0 = Math.floor(t0 * SR), len = Math.floor((dur + rel) * SR);
    const phases = Array.from({ length: voices }, () => rnd());
    const fs1 = Array.from({ length: voices }, (_, v) => freq * Math.pow(2, (voices === 1 ? 0 : (v / (voices - 1) - 0.5) * det) / 12));
    let y1 = 0, y2 = 0;
    for (let n = 0; n < len; n++) {
        const t = n / SR;
        let env = t < att ? t / att : 1;
        if (dec > 0) env *= Math.exp(-(t - Math.min(t, att)) / dec) * (1 - (o.sus ?? 0)) + (o.sus ?? 0);
        if (t > dur) env *= Math.max(0, 1 - (t - dur) / rel);
        let s = 0;
        for (let v = 0; v < voices; v++) {
            const dt = fs1[v] / SR;
            phases[v] += dt; if (phases[v] >= 1) phases[v] -= 1;
            if (o.wave === 'sine') s += Math.sin(phases[v] * Math.PI * 2);
            else if (o.wave === 'tri') s += 1 - 4 * Math.abs(phases[v] - 0.5);
            else s += 2 * phases[v] - 1 - blep(phases[v], dt);
        }
        s /= voices;
        const cut = typeof o.cut === 'function' ? o.cut(t0 + t, t) : (o.cut ?? 3000);
        const a = 1 - Math.exp(-2 * Math.PI * Math.min(cut, 18000) / SR);
        y1 += a * (s - y1); y2 += a * (y1 - y2);
        const out = y2 * env * gain;
        const l = out * (1 - Math.max(0, pan)), r = out * (1 + Math.min(0, pan));
        add(mus, i0 + n, l, r);
        if (o.send) add(verb, i0 + n, l * o.send, r * o.send);
    }
}

function kick(t0, g = 0.55) {
    const i0 = Math.floor(t0 * SR); let ph = 0;
    for (let n = 0; n < SR * 0.4; n++) {
        const t = n / SR;
        const f = 46 + 110 * Math.exp(-t / 0.04);
        ph += f / SR;
        const s = Math.sin(ph * Math.PI * 2) * Math.exp(-t / 0.16) + (t < 0.004 ? noise() * 0.4 : 0);
        add(mus, i0 + n, s * g, s * g);
    }
}
function snare(t0, g = 0.3) {
    const i0 = Math.floor(t0 * SR); const hp = lp1(1800); let ph = 0;
    for (let n = 0; n < SR * 0.25; n++) {
        const t = n / SR;
        const x = noise(); const h = x - hp(x);
        ph += 190 / SR;
        const s = h * Math.exp(-t / 0.07) * 0.9 + Math.sin(ph * Math.PI * 2) * Math.exp(-t / 0.04) * 0.6;
        add(mus, i0 + n, s * g, s * g);
        add(verb, i0 + n, s * g * 0.3, s * g * 0.3);
    }
}
function hat(t0, g = 0.07, d = 0.03, pan = 0.2) {
    const i0 = Math.floor(t0 * SR); const hp = lp1(6000);
    for (let n = 0; n < SR * 0.12; n++) {
        const t = n / SR; const x = noise(); const s = (x - hp(x)) * Math.exp(-t / d);
        add(mus, i0 + n, s * g * (1 - pan), s * g * (1 + pan));
    }
}
function taiko(t0, g = 0.6) {
    const i0 = Math.floor(t0 * SR); let ph = 0; const lp = lp1(900);
    for (let n = 0; n < SR * 1.0; n++) {
        const t = n / SR;
        const f = 58 + 70 * Math.exp(-t / 0.06);
        ph += f / SR;
        const s = Math.sin(ph * Math.PI * 2) * Math.exp(-t / 0.32) + lp(noise()) * Math.exp(-t / 0.05) * 1.5;
        add(mus, i0 + n, s * g, s * g);
        add(verb, i0 + n, s * g * 0.5, s * g * 0.5);
    }
}
function crash(t0, g = 0.18, d = 1.3) {
    const i0 = Math.floor(t0 * SR); const hp = lp1(4000); const hp2 = lp1(9000);
    for (let n = 0; n < SR * d * 3; n++) {
        const t = n / SR; const x = noise(); const h = x - hp(x); const s = (h * 0.8 + (x - hp2(x)) * 0.4) * Math.exp(-t / d);
        const w = noise() * 0.15;
        add(mus, i0 + n, s * g * (1 + w), s * g * (1 - w));
        add(verb, i0 + n, s * g * 0.4, s * g * 0.4);
    }
}
function boom(t0, g = 0.7, d = 1.6) {
    const i0 = Math.floor(t0 * SR); let ph = 0;
    for (let n = 0; n < SR * d * 2.5; n++) {
        const t = n / SR;
        const f = 30 + 55 * Math.exp(-t / 0.25);
        ph += f / SR;
        const s = Math.tanh(Math.sin(ph * Math.PI * 2) * 1.8) * Math.exp(-t / d) * (t < 0.005 ? t / 0.005 : 1);
        add(mus, i0 + n, s * g, s * g);
    }
}
function riser(t0, t1, g = 0.2, f0 = 300, f1 = 7000) {
    const i0 = Math.floor(t0 * SR), len = Math.floor((t1 - t0) * SR);
    let low = 0, band = 0;
    for (let n = 0; n < len; n++) {
        const k = n / len;
        const f = f0 * Math.pow(f1 / f0, k);
        const F = 2 * Math.sin(Math.PI * Math.min(f, 12000) / SR), Q = 0.25;
        const x = noise();
        low += F * band; const high = x - low - Q * band; band += F * high;
        const s = band * Math.pow(k, 1.8) * g;
        const w = Math.sin(k * 40) * 0.3;
        add(mus, i0 + n, s * (1 + w), s * (1 - w));
        add(verb, i0 + n, s * 0.4, s * 0.4);
    }
}
function rumble(t0, t1, g = 0.25) {
    const i0 = Math.floor(t0 * SR), len = Math.floor((t1 - t0) * SR);
    const lp = lp1(120), lp2 = lp1(120); let ph = 0;
    for (let n = 0; n < len; n++) {
        const k = n / len;
        ph += 38 / SR;
        const env = Math.min(1, k * 3) * Math.min(1, (1 - k) * 8);
        const s = (lp2(lp(noise())) * 6 + Math.sin(ph * Math.PI * 2) * 0.4) * env * g;
        add(mus, i0 + n, s, s);
    }
}
function whoosh(t0, d = 0.35, g = 0.16, up = true) {
    const i0 = Math.floor(t0 * SR), len = Math.floor(d * SR);
    let low = 0, band = 0;
    for (let n = 0; n < len; n++) {
        const k = n / len;
        const f = up ? 400 * Math.pow(12, k) : 5000 * Math.pow(1 / 12, k);
        const F = 2 * Math.sin(Math.PI * f / SR);
        const x = noise(); low += F * band; const high = x - low - 0.4 * band; band += F * high;
        const env = Math.sin(Math.PI * k);
        add(mus, i0 + n, band * env * g * (1 - k), band * env * g * k);
    }
}
function bell(t0, freq, g = 0.06, d = 1.4, pan = 0) {
    const i0 = Math.floor(t0 * SR);
    for (let n = 0; n < SR * d * 2; n++) {
        const t = n / SR;
        const s = (Math.sin(2 * Math.PI * freq * t) + 0.4 * Math.sin(2 * Math.PI * freq * 2.76 * t) * Math.exp(-t / 0.3) + 0.2 * Math.sin(2 * Math.PI * freq * 5.4 * t) * Math.exp(-t / 0.1)) * Math.exp(-t / d) * Math.min(1, t / 0.002);
        add(mus, i0 + n, s * g * (1 - pan), s * g * (1 + pan));
        add(verb, i0 + n, s * g * 0.6, s * g * 0.6);
    }
}

const CHORDS = { Am: [57, 60, 64], F: [53, 57, 60], C: [55, 60, 64], G: [55, 59, 62], Dm: [57, 62, 65], E: [56, 59, 64] };
const ROOT_NOTE = { Am: 45, F: 41, C: 48, G: 43, Dm: 38, E: 40 };
const prog = ['Am', 'F', 'C', 'G'];
const chordAt = t => prog[Math.floor(t / 2) % 4];

synthNote(0.0, 3.4, midi(57), { gain: 0.05, att: 1.2, rel: 0.6, cut: 900, voices: 4, detune: 0.2, send: 0.5 });
synthNote(0.0, 3.4, midi(64), { gain: 0.04, att: 1.4, rel: 0.6, cut: 900, voices: 4, detune: 0.2, send: 0.5, pan: 0.3 });
synthNote(0.0, 3.4, midi(45), { gain: 0.06, att: 1.0, rel: 0.6, cut: 500, voices: 2 });
const arp = [69, 72, 76, 72, 69, 72, 76, 79];
for (let i = 0; i < 14; i++) {
    const t = i * 0.25;
    if (t >= 3.3) break;
    bell(t, midi(arp[i % arp.length]), 0.035, 0.5, (i % 2 ? 0.35 : -0.35));
}
bell(1.53, midi(81), 0.05, 1.2);
bell(1.62, midi(88), 0.035, 1.2, 0.3);

synthNote(3.5, 2.5, midi(33), { gain: 0.09, att: 0.3, rel: 0.3, cut: t => 220 + 160 * Math.sin(t * 1.4), voices: 3, detune: 0.25 });
synthNote(3.5, 2.5, midi(40), { gain: 0.05, att: 0.6, rel: 0.3, cut: 380, voices: 3, detune: 0.3, send: 0.3 });
for (let i = 0; i < 10; i++) {
    const t = 3.5 + i * 0.25;
    if (t >= 6.0) break;
    const accent = i % 2 === 0;
    hat(t, accent ? 0.05 : 0.025, 0.02, accent ? -0.4 : 0.4);
}
bell(3.62, midi(76), 0.05, 0.6, -0.3);
bell(5.36, midi(71), 0.04, 0.7, 0.2);
bell(5.44, midi(70), 0.04, 0.7, -0.2);
rumble(4.9, 6.1, 0.35);
taiko(6.0, 0.7); whoosh(5.82, 0.2, 0.12);
taiko(6.5, 0.7); whoosh(6.32, 0.2, 0.12, false);
synthNote(6.0, 0.95, midi(45), { gain: 0.09, att: 0.01, dec: 0.4, rel: 0.2, cut: 1400, voices: 3, send: 0.4 });
synthNote(6.5, 0.45, midi(44), { gain: 0.09, att: 0.01, dec: 0.4, rel: 0.2, cut: 1400, voices: 3, send: 0.4 });

const buildChords = [[7.0, 'Am'], [8.0, 'F'], [9.0, 'G']];
for (const [t, ch] of buildChords) {
    for (const m of CHORDS[ch]) synthNote(t, 1.0, midi(m), { gain: 0.035, att: 0.15, rel: 0.1, cut: tt => 600 + (tt - 7) * 900, voices: 4, detune: 0.18, send: 0.4 });
    synthNote(t, 1.0, midi(ROOT_NOTE[ch]), { gain: 0.08, att: 0.02, rel: 0.1, cut: 700, voices: 2 });
}
taiko(7.0, 0.65);
for (let i = 0; i < 6; i++) taiko(7.5 + i * 0.5, 0.25 + i * 0.05);
for (let i = 0; i < 8; i++) snare(8.5 + i * 0.125, 0.06 + i * 0.012);
for (let i = 0; i < 8; i++) snare(9.5 + i * 0.0625, 0.12 + i * 0.015);
riser(7.0, 9.95, 0.24);
synthNote(8.4, 1.55, midi(57), { gain: 0.05, att: 1.2, rel: 0.05, cut: tt => 800 + (tt - 8.4) * 3000, voices: 3, detune: 0.3 });

function groove(t0, t1, o = {}) {
    for (let b = Math.round(t0 / BEAT); b * BEAT < t1 - 1e-6; b++) {
        const t = b * BEAT;
        kick(t, 0.5);
        if (b % 2 === 1) snare(t, 0.28);
        hat(t + BEAT / 2, 0.06, 0.035, 0.25);
        hat(t, 0.03, 0.02, -0.25);
        const ch = chordAt(t);
        for (let e = 0; e < 2; e++) {
            const tt = t + e * BEAT / 2;
            if (tt >= t1) break;
            synthNote(tt, 0.2, midi(ROOT_NOTE[ch] - 12 + (e === 1 ? 12 : 0)), { gain: 0.09, att: 0.003, dec: 0.12, sus: 0.3, rel: 0.05, cut: 900, voices: 2, detune: 0.1 });
        }
        if (b % 2 === 0) for (const m of CHORDS[ch]) synthNote(t, 0.42, midi(m + 12), { gain: 0.028, att: 0.005, dec: 0.2, sus: 0.25, rel: 0.1, cut: 2600, voices: 3, detune: 0.2, send: 0.35, pan: (m % 3 - 1) * 0.3 });
    }
}
crash(10.0, 0.2);
boom(10.0, 0.4, 0.5);
groove(10.0, 11.0);
boom(11.05, 0.55, 1.6);
for (const m of [57, 64, 69]) synthNote(11.0, 1.2, midi(m), { gain: 0.035, att: 0.3, rel: 0.3, cut: 500, voices: 4, detune: 0.25, send: 0.7 });
kick(11.4, 0.35); kick(11.85, 0.4);
riser(11.6, 12.48, 0.2, 400, 9000);
whoosh(12.15, 0.35, 0.18);
crash(12.5, 0.2);
groove(12.5, 15.75);
riser(15.25, 15.98, 0.16, 500, 8000);
kick(15.75, 0.5);
const stabs = [16.0, 16.17, 16.33, 16.5];
stabs.forEach((t, i) => {
    taiko(t, 0.55);
    crash(t, 0.08, 0.2);
    for (const m of CHORDS[['Am', 'F', 'G', 'E'][i]]) synthNote(t, 0.12, midi(m), { gain: 0.04, att: 0.003, rel: 0.08, cut: 2200, voices: 3, send: 0.5 });
});
boom(17.0, 0.8, 2.2);
crash(17.0, 0.26, 2.0);
taiko(17.0, 0.8);
for (const m of [45, 57, 60, 64, 69, 72, 76]) synthNote(17.0, 5.0, midi(m), { gain: m < 50 ? 0.08 : 0.03, att: 0.01, dec: 2.2, sus: 0.35, rel: 2.0, cut: tt => 600 + 2600 * Math.exp(-(tt - 17) / 1.2), voices: 4, detune: 0.2, send: 0.6 });
taiko(17.92, 0.4);
const endArp = [69, 76, 72, 79, 76, 81, 79, 84];
endArp.forEach((m, i) => bell(18.6 + i * 0.25, midi(m), 0.03, 1.0, i % 2 ? 0.4 : -0.4));
bell(20.8, midi(81), 0.04, 2.5);

function reverb(src) {
    const combs = [1557, 1617, 1491, 1422, 1277, 1356, 1188, 1116].map(d => Math.round(d * SR / 44100));
    const aps = [225, 556, 441, 341].map(d => Math.round(d * SR / 44100));
    const out = [new Float32Array(N), new Float32Array(N)];
    for (let ch = 0; ch < 2; ch++) {
        const x = src[ch];
        const off = ch * 23;
        const y = out[ch];
        for (const d0 of combs) {
            const d = d0 + off; const buf = new Float32Array(d); let idx = 0, f = 0;
            for (let n = 0; n < N; n++) {
                const o = buf[idx];
                f = o * 0.7 + f * 0.3;
                buf[idx] = x[n] + f * 0.84;
                idx = (idx + 1) % d;
                y[n] += o / combs.length;
            }
        }
        for (const d0 of aps) {
            const d = d0 + off; const buf = new Float32Array(d); let idx = 0;
            for (let n = 0; n < N; n++) {
                const bo = buf[idx]; const v = y[n] + bo * 0.5;
                buf[idx] = v; y[n] = bo - v * 0.5;
                idx = (idx + 1) % d;
            }
        }
    }
    return out;
}
const wet = reverb(verb);

function slowFilter() {
    const a = 10.85, b = 11.1, c = 11.85, d = 12.3;
    for (let ch = 0; ch < 2; ch++) {
        let y1 = 0, y2 = 0;
        for (let n = Math.floor(10.5 * SR); n < Math.floor(12.6 * SR); n++) {
            const t = n / SR;
            let k = t < a ? 0 : t < b ? (t - a) / (b - a) : t < c ? 1 : t < d ? 1 - (t - c) / (d - c) : 0;
            const cut = 18000 * Math.pow(220 / 18000, k);
            const al = 1 - Math.exp(-2 * Math.PI * cut / SR);
            y1 += al * (mus[ch][n] - y1); y2 += al * (y1 - y2);
            mus[ch][n] = k <= 0 ? mus[ch][n] : y2;
        }
    }
}

const sndCache = new Map();
function loadSnd(name) {
    if (sndCache.has(name)) return sndCache.get(name);
    const raw = execFileSync('/opt/homebrew/bin/ffmpeg', ['-v', 'error', '-i', path.join(ROOT, 'snd', name + '.wav'), '-f', 'f32le', '-ac', '2', '-ar', String(SR), '-']);
    const f = new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4);
    const L = new Float32Array(f.length / 2), R = new Float32Array(f.length / 2);
    for (let i = 0; i < L.length; i++) { L[i] = f[i * 2]; R[i] = f[i * 2 + 1]; }
    const v = [L, R];
    sndCache.set(name, v);
    return v;
}
const cues = JSON.parse(fs.readFileSync(path.join(ROOT, 'out', 'cues.json'), 'utf8'));
for (const c of cues) {
    const [L, R] = loadSnd(c.name);
    const i0 = Math.floor(c.t * SR);
    const len = Math.floor(L.length / c.rate);
    for (let n = 0; n < len; n++) {
        const p = n * c.rate, j = Math.floor(p), fr = p - j;
        if (j + 1 >= L.length) break;
        add(sfx, i0 + n, (L[j] + (L[j + 1] - L[j]) * fr) * c.gain, (R[j] + (R[j + 1] - R[j]) * fr) * c.gain);
    }
}

slowFilter();
const outBuf = Buffer.alloc(N * 2 * 4);
let peak = 0;
for (let n = 0; n < N; n++) {
    const fade = n / SR > DUR - 1.2 ? Math.max(0, (DUR - n / SR) / 1.2) : 1;
    for (let ch = 0; ch < 2; ch++) {
        const v = (mus[ch][n] * 0.9 + wet[ch][n] * 0.55 + sfx[ch][n] * 0.85) * fade;
        const s = Math.tanh(v * 1.1);
        peak = Math.max(peak, Math.abs(s));
        outBuf.writeFloatLE(s, (n * 2 + ch) * 4);
    }
}
const rawPath = path.join(ROOT, 'out', 'audio.f32');
fs.writeFileSync(rawPath, outBuf);
execFileSync('/opt/homebrew/bin/ffmpeg', ['-y', '-v', 'error', '-f', 'f32le', '-ar', String(SR), '-ac', '2', '-i', rawPath, '-af', 'loudnorm=I=-14:TP=-1.2:LRA=11', '-ar', String(SR), path.join(ROOT, 'out', 'audio.wav')]);
fs.unlinkSync(rawPath);
console.log('audio done, pre-norm peak', peak.toFixed(3), 'cues', cues.length);
