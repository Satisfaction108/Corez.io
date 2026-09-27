#!/usr/bin/env node
'use strict';
// Objective QA for the sound library (you can't always listen, so measure).
//
//   node scripts/sfx/analyze.js [outDir]
//
// Decodes every shipped MP3 (what players actually get) and reports per file:
// duration, sample peak dBFS, RMS, max-100ms loudness (LUFS-ish, K-weighted),
// spectral centroid, lead (decoder/encoder silence before the first sample
// above -50 dBFS), attack (lead -> 50% of peak), clipping, DC offset and end
// level. Also writes one spectrogram PNG per file into outDir/spec/ and
// metrics.json / metrics.txt into outDir. Exits non-zero on hard failures.
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const zlib = require('zlib');
const D = require('./dsp.js');

const ROOT = path.resolve(__dirname, '../..');
const LIB = path.join(ROOT, 'public/sounds/sfx');
const OUT = path.resolve(process.argv[2] || path.join(require('os').tmpdir(), 'corez-sfx-qa'));
const FFMPEG = process.env.FFMPEG || (fs.existsSync('/opt/homebrew/bin/ffmpeg') ? '/opt/homebrew/bin/ffmpeg' : 'ffmpeg');
const SR = 44100;

function decode(file) {
    const probe = cp.execFileSync(FFMPEG.replace(/ffmpeg$/, 'ffprobe'), ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=channels', '-of', 'csv=p=0', file]).toString().trim();
    const nc = parseInt(probe, 10) || 1;
    const raw = cp.execFileSync(FFMPEG, ['-v', 'error', '-i', file, '-f', 'f32le', '-ar', String(SR), '-'], { maxBuffer: 1 << 28 });
    const all = new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4);
    const n = all.length / nc, chs = [];
    for (let c = 0; c < nc; c++) { const a = new Float32Array(n); for (let i = 0; i < n; i++) a[i] = all[i * nc + c]; chs.push(a); }
    return chs;
}

// radix-2 FFT (in place) on re/im
function fft(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
        let bit = n >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
    }
    for (let len = 2; len <= n; len <<= 1) {
        const ang = (-2 * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang);
        for (let i = 0; i < n; i += len) {
            let cr = 1, ci = 0;
            for (let k = 0; k < len / 2; k++) {
                const a = i + k, b = a + len / 2;
                const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
                re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
                const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
            }
        }
    }
}

const WIN = 1024, HOP = 256;
function stft(x) {
    const frames = [], hann = new Float32Array(WIN);
    for (let i = 0; i < WIN; i++) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (WIN - 1));
    for (let s = 0; s + WIN <= x.length + WIN / 2; s += HOP) {
        const re = new Float64Array(WIN), im = new Float64Array(WIN);
        for (let i = 0; i < WIN; i++) re[i] = (x[s + i] || 0) * hann[i];
        fft(re, im);
        const mag = new Float32Array(WIN / 2);
        for (let k = 0; k < WIN / 2; k++) mag[k] = Math.hypot(re[k], im[k]);
        frames.push(mag);
    }
    return frames;
}

// ── PNG writer (8-bit RGB) ────────────────────────────────────────────────
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf) { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
}
function png(w, h, rgb) {
    const raw = Buffer.alloc((w * 3 + 1) * h);
    for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3); }
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
// magma-ish colour ramp
function ramp(u) {
    u = Math.max(0, Math.min(1, u));
    const stops = [[0, 0, 4], [40, 11, 84], [140, 41, 129], [222, 73, 104], [254, 159, 109], [252, 253, 191]];
    const p = u * (stops.length - 1), i = Math.min(stops.length - 2, Math.floor(p)), f = p - i;
    return stops[i].map((a, k) => Math.round(a + (stops[i + 1][k] - a) * f));
}
function spectrogramPng(frames, file) {
    const H = 160, FMAX = 12000, FMIN = 40;
    const w = Math.max(120, Math.min(900, frames.length * 2)), rgb = Buffer.alloc(w * H * 3);
    for (let x = 0; x < w; x++) {
        const fr = frames[Math.min(frames.length - 1, Math.floor((x / w) * frames.length))];
        for (let y = 0; y < H; y++) {
            // log-frequency axis so the low end (rock, booms) is readable
            const f = FMIN * Math.pow(FMAX / FMIN, 1 - y / (H - 1));
            const k = Math.min(fr.length - 1, Math.round((f / SR) * WIN));
            const db = 20 * Math.log10(fr[k] / (WIN / 4) + 1e-9);
            const c = ramp((db + 90) / 90);
            const o = (y * w + x) * 3; rgb[o] = c[0]; rgb[o + 1] = c[1]; rgb[o + 2] = c[2];
        }
    }
    fs.writeFileSync(file, png(w, H, rgb));
}

function metrics(chs) {
    const n = chs[0].length, mid = new Float32Array(n);
    for (const c of chs) for (let i = 0; i < n; i++) mid[i] += c[i] / chs.length;
    let pk = 0, sum = 0, dc = 0, clip = 0;
    for (const c of chs) for (let i = 0; i < n; i++) { const a = Math.abs(c[i]); if (a > pk) pk = a; if (a >= 0.999) clip++; }
    for (let i = 0; i < n; i++) { sum += mid[i] * mid[i]; dc += mid[i]; }
    const thr = Math.pow(10, -50 / 20);
    let lead = 0; while (lead < n && Math.abs(mid[lead]) < thr) lead++;
    let att = lead; while (att < n && Math.abs(mid[att]) < pk * 0.5 / (chs.length > 1 ? 1 : 1)) att++;
    const frames = stft(mid);
    let num = 0, den = 0;
    for (const fr of frames) for (let k = 1; k < fr.length; k++) { const p = fr[k] * fr[k]; num += p * (k * SR / WIN); den += p; }
    let endAbs = 0; for (const c of chs) endAbs = Math.max(endAbs, Math.abs(c[n - 1]));
    return {
        dur: n / SR, ch: chs.length,
        peakDb: 20 * Math.log10(pk + 1e-12),
        rmsDb: 10 * Math.log10(sum / n + 1e-12),
        lufsMax: D.loudMax(mid), lufsInt: D.loudInt(mid),
        centroid: den ? num / den : 0,
        leadMs: (lead / SR) * 1000, attackMs: ((att - lead) / SR) * 1000,
        clip, dc: dc / n, endDb: 20 * Math.log10(endAbs + 1e-12),
        frames,
    };
}

function main() {
    const man = JSON.parse(fs.readFileSync(path.join(LIB, 'manifest.json'), 'utf8'));
    fs.mkdirSync(path.join(OUT, 'spec'), { recursive: true });
    const rows = [];
    let fail = 0;
    for (const [name, e] of Object.entries(man.sounds)) {
        for (let v = 1; v <= e.n; v++) {
            const rel = `${e.family}/${name}_v${v}.mp3`;
            const m = metrics(decode(path.join(LIB, rel)));
            spectrogramPng(m.frames, path.join(OUT, 'spec', `${name}_v${v}.png`));
            delete m.frames;
            const bytes = fs.statSync(path.join(LIB, rel)).size;
            const problems = [];
            if (m.clip > 0) problems.push('CLIP');
            if (m.peakDb > -0.5) problems.push('HOT');
            if (Math.abs(m.dc) > 0.002) problems.push('DC');
            if (m.endDb > -50 && !man.loops[name]) problems.push('ENDCLICK');
            if (problems.length) fail++;
            rows.push({ name, v, family: e.family, file: rel, bytes, ...m, problems });
        }
    }
    const fmt = (x, d = 1) => (x >= 0 ? ' ' : '') + x.toFixed(d);
    const lines = ['file                                   dur   peak   lufsM  lufsI  cent   lead  att   kB   flags'];
    for (const r of rows) {
        lines.push(`${r.file.padEnd(38)} ${r.dur.toFixed(2)} ${fmt(r.peakDb)} ${fmt(r.lufsMax)} ${fmt(r.lufsInt)} ${String(Math.round(r.centroid)).padStart(5)} ${r.leadMs.toFixed(1).padStart(5)} ${r.attackMs.toFixed(1).padStart(5)} ${(r.bytes / 1024).toFixed(1).padStart(5)} ${r.problems.join(',')}`);
    }
    const total = rows.reduce((a, r) => a + r.bytes, 0);
    lines.push(`\n${rows.length} files, ${(total / 1024).toFixed(0)} KB total, ${fail} with problems`);
    fs.writeFileSync(path.join(OUT, 'metrics.txt'), lines.join('\n') + '\n');
    fs.writeFileSync(path.join(OUT, 'metrics.json'), JSON.stringify(rows, null, 1));
    console.log(lines.join('\n'));
    process.exitCode = fail ? 1 : 0;
}
main();
