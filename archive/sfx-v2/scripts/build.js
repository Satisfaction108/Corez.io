#!/usr/bin/env node
'use strict';
// Regenerates the whole Corez sound library from code.
//
//   node scripts/sfx/build.js                 # everything -> public/sounds/sfx/
//   node scripts/sfx/build.js --only gem_t1,kill
//   node scripts/sfx/build.js --wav /some/dir # also keep the mastered WAVs
//
// Output: public/sounds/sfx/<family>/<name>_v<n>.mp3 + manifest.json.
// Needs ffmpeg (libmp3lame) at BUILD time only; the game just plays MP3s.
// Deterministic: every random draw is seeded from the sound name + variant.
const fs = require('fs');
const path = require('path');
const os = require('os');
const cp = require('child_process');
const D = require('./dsp.js');
const { SOUNDS, LOOPS } = require('./recipes.js');

const ROOT = path.resolve(__dirname, '../..');
const OUT = path.join(ROOT, 'public/sounds/sfx');
const argv = process.argv.slice(2);
const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const only = arg('--only') ? new Set(arg('--only').split(',')) : null;
const keepWav = arg('--wav');
const FFMPEG = process.env.FFMPEG || (fs.existsSync('/opt/homebrew/bin/ffmpeg') ? '/opt/homebrew/bin/ffmpeg' : 'ffmpeg');
const CEIL = Math.pow(10, -1.0 / 20);        // -1 dBFS sample-peak ceiling

function master(chs, target, loop) {
    chs = chs.map((c) => D.hp(D.dcBlock(c), 28, 0.707));   // nothing useful lives under 28 Hz
    if (!loop) chs = D.trimTail(chs, -60, 0.012);
    const mid = new Float32Array(chs[0].length);
    for (const c of chs) for (let i = 0; i < mid.length; i++) mid[i] += c[i] / chs.length;
    const L = D.loudMax(mid);
    let g = Math.pow(10, (target - L) / 20);
    let pk = 0;
    for (const c of chs) pk = Math.max(pk, D.peakOf(c));
    // never ask the limiter for more than ~5 dB: keeps transients punchy
    if (pk * g > CEIL * 1.8) g = (CEIL * 1.8) / pk;
    for (const c of chs) D.gain(c, g);
    D.limit(chs, CEIL);
    if (!loop) for (const c of chs) D.fade(c, 0.0003, 0.006);
    return chs;
}

function wav(chs) {
    const n = chs[0].length, nc = chs.length, bytes = n * nc * 4;
    const b = Buffer.alloc(44 + bytes);
    b.write('RIFF', 0); b.writeUInt32LE(36 + bytes, 4); b.write('WAVE', 8);
    b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(3, 20); b.writeUInt16LE(nc, 22);
    b.writeUInt32LE(D.SR, 24); b.writeUInt32LE(D.SR * nc * 4, 28); b.writeUInt16LE(nc * 4, 32); b.writeUInt16LE(32, 34);
    b.write('data', 36); b.writeUInt32LE(bytes, 40);
    let o = 44;
    for (let i = 0; i < n; i++) for (let c = 0; c < nc; c++) { b.writeFloatLE(chs[c][i], o); o += 4; }
    return b;
}

function main() {
    const tmp = keepWav || fs.mkdtempSync(path.join(os.tmpdir(), 'corez-sfx-'));
    fs.mkdirSync(tmp, { recursive: true });
    if (!only && fs.existsSync(OUT)) fs.rmSync(OUT, { recursive: true, force: true });
    fs.mkdirSync(OUT, { recursive: true });
    const manPath = path.join(OUT, 'manifest.json');
    const manifest = only && fs.existsSync(manPath) ? JSON.parse(fs.readFileSync(manPath, 'utf8')) : { sounds: {}, loops: LOOPS };
    let total = 0, count = 0;
    const t0 = Date.now();
    for (const s of SOUNDS) {
        if (only && !only.has(s.name)) continue;
        const dir = path.join(OUT, s.family);
        fs.mkdirSync(dir, { recursive: true });
        const loop = !!LOOPS[s.name];
        const entry = { family: s.family, n: s.n, stereo: s.stereo, dur: [], bytes: [] };
        for (let v = 0; v < s.n; v++) {
            const rng = D.rngOf(D.hashStr(s.name + ':' + v));
            const x = s.fn(rng, v);
            let chs;
            if (x.L) chs = s.stereo ? [x.L, x.R] : [x.L.map((a, i) => (a + x.R[i]) / 2)];
            else chs = s.stereo ? [x, Float32Array.from(x)] : [x];
            chs = master(chs, s.target, loop);
            const base = `${s.name}_v${v + 1}`;
            const wp = path.join(tmp, base + '.wav');
            fs.writeFileSync(wp, wav(chs));
            const mp = path.join(dir, base + '.mp3');
            const br = s.stereo ? '96k' : '80k';
            cp.execFileSync(FFMPEG, ['-y', '-loglevel', 'error', '-i', wp, '-codec:a', 'libmp3lame', '-b:a', br,
                '-ac', String(chs.length), '-ar', '44100', '-map_metadata', '-1', '-id3v2_version', '0', '-write_xing', '1', mp]);
            const sz = fs.statSync(mp).size;
            entry.dur.push(+(chs[0].length / D.SR).toFixed(3));
            entry.bytes.push(sz);
            total += sz; count++;
        }
        manifest.sounds[s.name] = entry;
        process.stdout.write(`  ${s.family.padEnd(9)} ${s.name.padEnd(18)} x${s.n}  ${entry.dur.join('/')}s\n`);
    }
    fs.writeFileSync(manPath, JSON.stringify(manifest, null, 1) + '\n');
    if (!keepWav) fs.rmSync(tmp, { recursive: true, force: true });
    const all = Object.values(manifest.sounds).reduce((a, e) => a + e.bytes.reduce((x, y) => x + y, 0), 0);
    console.log(`built ${count} files (${(total / 1024).toFixed(0)} KB) in ${((Date.now() - t0) / 1000).toFixed(1)}s; library total ${(all / 1024).toFixed(0)} KB`);
}
main();
