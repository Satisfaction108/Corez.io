// Dig Wars sound system — stylized, ear-friendly foley.
//
// Design: Fortnite-like punch (layered sub + body + air) without realistic
// stone/metal and without sci-fi lasers. Every event is a rounded mid-low
// "tok / foomp / bloom" built from sines and brown/pink noise. No white-noise
// gravel, no 1ms clicks, no 3kHz ice-picks, no pebble grains.
//
// Master bus high-cuts the fatiguing band so a bullet-storm stays soft.
// World sounds are distance-attenuated and stereo-panned, with throttles
// and busy-ducking so mining never turns into a machine gun.
// Sample hits live in public/sounds/ and skip the synth color filters.
//
// Console API: gameSound.setVolume(0..1), gameSound.mute()
import { global } from "./global.js";

const VOLUME_KEY = 'dw_soundVolume';
const PREFS_KEY = 'dw_soundPrefs';

const MIX_CATS = [
    { id: 'combat',      label: 'Combat' },
    { id: 'deaths',      label: 'Deaths' },
    { id: 'guns',        label: 'Guns' },
    { id: 'drones',      label: 'Drones' },
    { id: 'mining',      label: 'Mining' },
    { id: 'gems',        label: 'Gems' },
    { id: 'depositing',  label: 'Depositing' },
    { id: 'celebration', label: 'Bank Celebration' },
    { id: 'ui',          label: 'Menu & Upgrades' },
    { id: 'movement',    label: 'Rammer Movement' },
    { id: 'satchel',     label: 'Satchel Tension' },
];

function defaultPrefs() {
    const cats = {}, catOn = {};
    for (const c of MIX_CATS) { cats[c.id] = 1; catOn[c.id] = true; }
    let vol = parseFloat(localStorage.getItem(VOLUME_KEY));
    if (isNaN(vol)) vol = 0.7;
    return {
        enabled: true,
        headphones3d: true,
        volume: vol,
        busyDuck: true,
        farSounds: true,
        muteHidden: true,
        cats, catOn,
    };
}

function loadPrefs() {
    const d = defaultPrefs();
    try {
        const raw = JSON.parse(localStorage.getItem(PREFS_KEY) || 'null');
        if (!raw || typeof raw !== 'object') return d;
        if (typeof raw.enabled === 'boolean') d.enabled = raw.enabled;
        if (typeof raw.headphones3d === 'boolean') d.headphones3d = raw.headphones3d;
        if (typeof raw.volume === 'number') d.volume = Math.max(0, Math.min(1, raw.volume));
        if (typeof raw.busyDuck === 'boolean') d.busyDuck = raw.busyDuck;
        if (typeof raw.farSounds === 'boolean') d.farSounds = raw.farSounds;
        if (typeof raw.muteHidden === 'boolean') d.muteHidden = raw.muteHidden;
        if (raw.cats && typeof raw.cats === 'object') {
            for (const c of MIX_CATS) {
                const n = parseFloat(raw.cats[c.id]);
                if (!isNaN(n)) d.cats[c.id] = Math.max(0, Math.min(1, n));
            }
        }
        if (raw.catOn && typeof raw.catOn === 'object') {
            for (const c of MIX_CATS) {
                if (typeof raw.catOn[c.id] === 'boolean') d.catOn[c.id] = raw.catOn[c.id];
            }
        }
    } catch (e) { /* keep defaults */ }
    return d;
}

// MASTER KILL SWITCH — flip to false to silence everything; call sites stay wired.
const SOUND_ENABLED = true;

const jit = (n, amt = 0.06) => n * (1 - amt + Math.random() * amt * 2);

// ── Satchel tension ────────────────────────────────────────────────────────
// Below TENSION_START you are not carrying enough to be afraid of losing, so
// the heart stays quiet - otherwise the effect is wallpaper and stops meaning
// anything. Above it the beat accelerates all the way to the cap.
const TENSION_START = 0.30;
const HEART_SLOW    = 1180;   // ms between beats the moment tension starts
const HEART_FAST    = 430;    // ms between beats at a full satchel

// Drop files in public/sounds/. Missing optional clips just keep the synth.
const SAMPLES = {
    shoot:         '/sounds/shoot.wav',
    droneSpawn:    '/sounds/drone-spawn.wav',
    rockHit:       '/sounds/rock-hit.wav',
    rockBreak:     '/sounds/rock-break.wav',
    oreBreak:      '/sounds/ore-break.wav',
    gemPickup:     '/sounds/gem-pickup.wav',
    combatHit:     '/sounds/combat-hit.wav',
    combatHurt:    '/sounds/combat-hurt.wav',
    combatKill:    '/sounds/combat-kill.wav',
    dieOnScreen:   '/sounds/die-on-screen.wav',
    satchelFull:   '/sounds/satchel-full.wav',
    depositTick:   '/sounds/deposit-tick.wav',
    depositDone:   '/sounds/deposit-done.wav',
    bankCelebrate: '/sounds/bank-celebrate.mp3',
    uiClick:       '/sounds/buttonclick.wav',
    rammerMove:    '/sounds/rammer-move.wav',
};
const SAMPLE_FALLBACK = {
    bankCelebrate: '/sounds/bank-celebrate.wav',
};
const REQUIRED_SAMPLES = new Set(['shoot', 'rockBreak', 'oreBreak']);

class GameSound {
    constructor() {
        this.ctx     = null;
        this.master  = null;  // colored synth bus
        this.dry     = null;  // uncolored sample bus (keeps WAVs crisp)
        this.out     = null;  // synth master volume
        this.sampleGain = null;
        this._pink   = null;
        this._brown  = null;
        this._buf    = {};
        this._last   = {};
        this._recent = [];
        this._shoots = [];
        this._loops  = {};
        // Exposed so the satchel vignette starts at exactly the same load the
        // heartbeat does. Two thresholds that can drift apart would read as a
        // rendering bug, not a design choice.
        this.tensionStart = TENSION_START;
        const prefs = loadPrefs();
        this.enabled = prefs.enabled;
        this.headphones3d = prefs.headphones3d;
        this.volume = prefs.volume;
        this.busyDuck = prefs.busyDuck;
        this.farSounds = prefs.farSounds;
        this.muteHidden = prefs.muteHidden;
        this.cats = prefs.cats;
        this.catOn = prefs.catOn;
        this._tabHidden = false;
        this._hookGesture();
        this._hookUiClicks();
        this._hookPrefsUi();
    }

    _hookGesture() {
        const kick = () => { this._init(); if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); };
        for (const ev of ['pointerdown', 'keydown', 'touchstart'])
            document.addEventListener(ev, kick, { passive: true });
    }

    _hookUiClicks() {
        const hit = (el) => el && el.closest && el.closest(
            'button, .sp-tab, b[data-key], input[type=checkbox], input[type=range], select, label, #homeSettingsClose, #homeSettingsOverlay'
        );
        document.addEventListener('click', (e) => {
            if (!global.gameStart) return;
            const el = hit(e.target);
            if (!el) return;
            if (el.tagName === 'CANVAS' || (el.id && el.id.startsWith('gameCanvas'))) return;
            if (el.closest && el.closest('#startMenuWrapper')) return;
            this.uiClick();
        }, true);
    }

    _savePrefs() {
        const prefs = {
            enabled: this.enabled,
            headphones3d: this.headphones3d,
            volume: this.volume,
            busyDuck: this.busyDuck,
            farSounds: this.farSounds,
            muteHidden: this.muteHidden,
            cats: { ...this.cats },
            catOn: { ...this.catOn },
        };
        localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
        localStorage.setItem(VOLUME_KEY, this.volume);
    }

    _applyMaster() {
        const live = SOUND_ENABLED && this.enabled && this.volume > 0 && !(this.muteHidden && this._tabHidden);
        const g = live ? this.volume : 0;
        if (this.out) this.out.gain.value = g;
        if (this.sampleGain) this.sampleGain.gain.value = g;
        if (!live && this._loops.rammerMove) this._setLoopGain('rammerMove', 0.0001);
        const pane = document.getElementById('sp-sound');
        if (pane) pane.classList.toggle('is-muted', !this.enabled);
    }

    _mix(cat) {
        if (!SOUND_ENABLED || !this.enabled) return 0;
        if (this.muteHidden && this._tabHidden) return 0;
        if (!this.ctx || this.ctx.state !== 'running' || this.volume <= 0) return 0;
        if (cat && this.catOn[cat] === false) return 0;
        return cat ? (this.cats[cat] ?? 1) : 1;
    }

    _hookPrefsUi() {
        const boot = () => {
            const pane = document.getElementById('sp-sound');
            const mixHost = document.getElementById('sfxMix');
            if (!pane || !mixHost || mixHost.dataset.ready) return;
            mixHost.dataset.ready = '1';
            mixHost.className = 'sp-mix';
            for (const c of MIX_CATS) {
                const row = document.createElement('div');
                row.className = 'sp-mix-row';
                row.innerHTML =
                    `<label class="container"><input class="checkbox" type="checkbox" data-sfx-on="${c.id}" ${this.catOn[c.id] ? 'checked' : ''}><span class="checkmark"></span></label>` +
                    `<span>${c.label}</span>` +
                    `<input type="range" min="0" max="100" value="${Math.round((this.cats[c.id] ?? 1) * 100)}" data-sfx-vol="${c.id}">` +
                    `<b data-sfx-val="${c.id}">${Math.round((this.cats[c.id] ?? 1) * 100)}%</b>`;
                mixHost.appendChild(row);
            }
            const on = document.getElementById('sfxOn');
            const hp = document.getElementById('sfxHeadphones');
            const vol = document.getElementById('sfxVolume');
            const volVal = document.getElementById('sfxVolumeVal');
            const duck = document.getElementById('sfxBusyDuck');
            const far = document.getElementById('sfxFarSounds');
            const hide = document.getElementById('sfxMuteHidden');
            if (on) on.checked = this.enabled;
            if (hp) hp.checked = this.headphones3d;
            if (vol) vol.value = String(Math.round(this.volume * 100));
            if (volVal) volVal.textContent = Math.round(this.volume * 100) + '%';
            if (duck) duck.checked = this.busyDuck;
            if (far) far.checked = this.farSounds;
            if (hide) hide.checked = this.muteHidden;
            pane.classList.toggle('is-muted', !this.enabled);

            pane.addEventListener('change', (e) => {
                const t = e.target;
                if (!t) return;
                if (t.id === 'sfxOn') this.enabled = t.checked;
                else if (t.id === 'sfxHeadphones') this.headphones3d = t.checked;
                else if (t.id === 'sfxBusyDuck') this.busyDuck = t.checked;
                else if (t.id === 'sfxFarSounds') this.farSounds = t.checked;
                else if (t.id === 'sfxMuteHidden') this.muteHidden = t.checked;
                else if (t.dataset.sfxOn) this.catOn[t.dataset.sfxOn] = t.checked;
                this._savePrefs();
                this._applyMaster();
            });
            pane.addEventListener('input', (e) => {
                const t = e.target;
                if (!t) return;
                if (t.id === 'sfxVolume') {
                    this.setVolume(parseInt(t.value, 10) / 100);
                    if (volVal) volVal.textContent = t.value + '%';
                    return;
                }
                const id = t.dataset.sfxVol;
                if (!id) return;
                this.cats[id] = Math.max(0, Math.min(1, parseInt(t.value, 10) / 100));
                const lab = pane.querySelector(`[data-sfx-val="${id}"]`);
                if (lab) lab.textContent = t.value + '%';
                this._savePrefs();
            });
            document.addEventListener('visibilitychange', () => {
                this._tabHidden = document.hidden;
                this._applyMaster();
            });
        };
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
        else boot();
    }

    _init() {
        if (!SOUND_ENABLED) return;
        if (this.ctx) return;
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        this.ctx = new AC();

        // synth -> highshelf/lowpass (ear-safe) ┐
        // samples -> dry (uncolored)            ├─> volume -> compressor -> out
        this.master = this.ctx.createGain();
        this.dry    = this.ctx.createGain();
        this.out    = this.ctx.createGain();

        const shelf = this.ctx.createBiquadFilter();
        shelf.type = 'highshelf';
        shelf.frequency.value = 2200;
        shelf.gain.value = -12;

        const air = this.ctx.createBiquadFilter();
        air.type = 'lowpass';
        air.frequency.value = 4800;
        air.Q.value = 0.45;

        const comp = this.ctx.createDynamicsCompressor();
        comp.threshold.value = -26;
        comp.knee.value      = 30;
        comp.ratio.value     = 3.2;
        comp.attack.value    = 0.01;
        comp.release.value   = 0.28;

        this.master.connect(shelf);
        shelf.connect(air);
        air.connect(this.out);
        this.out.connect(comp);
        comp.connect(this.ctx.destination);

        // Samples skip the synth filters AND the compressor so the WAV
        // plays at the same loudness/tone you hear in a media player.
        this.sampleGain = this.ctx.createGain();
        this.dry.connect(this.sampleGain);
        this.sampleGain.connect(this.ctx.destination);
        this._applyMaster();

        this._pink  = this._makeNoise('pink');
        this._brown = this._makeNoise('brown');
        this._loadSamples();
    }

    async _loadSamples() {
        await Promise.all(Object.entries(SAMPLES).map(async ([key, url]) => {
            const urls = [url, SAMPLE_FALLBACK[key]].filter(Boolean);
            for (const u of urls) {
                try {
                    const res = await fetch(u);
                    if (!res.ok) continue;
                    const arr = await res.arrayBuffer();
                    this._buf[key] = await this.ctx.decodeAudioData(arr.slice(0));
                    return;
                } catch (e) { /* try fallback */ }
            }
            if (REQUIRED_SAMPLES.has(key)) console.warn('sfx failed to load', url);
        }));
    }

    // Plays a decoded WAV as-is (no pitch, no filter). Ducking is volume only.
    _playSample(name, { peak = 1, pan = 0, rate = 1, delay = 0, duck = true } = {}) {
        const buf = this._buf[name];
        if (!buf || !this.dry) return false;
        if (!isFinite(peak) || !isFinite(pan) || !isFinite(rate) || !isFinite(delay)) return false;
        const t0 = this.ctx.currentTime + Math.max(0, delay);
        const s = this.ctx.createBufferSource();
        s.buffer = buf;
        s.playbackRate.value = Math.max(0.1, Math.min(4, rate));
        const g = this.ctx.createGain();
        const vol = Math.max(0.0001, Math.min(4, peak * (duck ? this._busyGain() : 1)));
        if (!isFinite(vol)) return false;
        pan = Math.max(-1, Math.min(1, pan));
        g.gain.setValueAtTime(vol, t0);
        s.connect(g);
        let node = g;
        if (this.ctx.createStereoPanner) {
            const p = this.ctx.createStereoPanner();
            p.pan.value = pan;
            g.connect(p);
            node = p;
        }
        node.connect(this.dry);
        s.start(t0);
        return true;
    }

    _ensureLoop(name) {
        if (this._loops[name]) return this._loops[name];
        const buf = this._buf[name];
        if (!buf || !this.dry) return null;
        const s = this.ctx.createBufferSource();
        s.buffer = buf;
        s.loop = true;
        const g = this.ctx.createGain();
        g.gain.value = 0.0001;
        s.connect(g);
        g.connect(this.dry);
        s.start();
        const loop = { src: s, gain: g };
        this._loops[name] = loop;
        return loop;
    }

    _setLoopGain(name, peak) {
        const loop = this._ensureLoop(name);
        if (!loop) return false;
        const t = this.ctx.currentTime;
        const v = Math.max(0.0001, peak);
        loop.gain.gain.cancelScheduledValues(t);
        loop.gain.gain.setTargetAtTime(v, t, 0.08);
        return true;
    }

    _makeNoise(kind) {
        const len = this.ctx.sampleRate;
        const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
        const d = buf.getChannelData(0);
        if (kind === 'brown') {
            let last = 0;
            for (let i = 0; i < len; i++) {
                last += (Math.random() * 2 - 1) * 0.014;
                last *= 0.996;
                d[i] = last;
            }
        } else {
            // Paul Kellet pink
            let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
            for (let i = 0; i < len; i++) {
                const w = Math.random() * 2 - 1;
                b0 = 0.99886 * b0 + w * 0.0555179;
                b1 = 0.99332 * b1 + w * 0.0750759;
                b2 = 0.96900 * b2 + w * 0.1538520;
                b3 = 0.86650 * b3 + w * 0.3104856;
                b4 = 0.55000 * b4 + w * 0.5329522;
                b5 = -0.7616 * b5 - w * 0.0168980;
                d[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
                b6 = w * 0.115926;
            }
        }
        let peak = 0;
        for (let i = 0; i < len; i++) peak = Math.max(peak, Math.abs(d[i]));
        const g = peak > 0 ? 0.9 / peak : 1;
        for (let i = 0; i < len; i++) d[i] *= g;
        return buf;
    }

    setVolume(v) {
        this.volume = Math.max(0, Math.min(1, v));
        this._savePrefs();
        this._applyMaster();
    }
    mute() { this.setVolume(0); }

    _ready(cat) { return this._mix(cat) > 0; }

    _spatial(x, y) {
        const lx = global.player ? global.player.renderx : 0;
        const ly = global.player ? global.player.rendery : 0;
        const dx = x - lx, dy = y - ly;
        const d  = Math.hypot(dx, dy);
        const MAXD = this.farSounds ? 3200 : 1400;
        if (!isFinite(d) || d > MAXD) return null;
        const t   = Math.max(0, (d - 500) / (MAXD - 500));
        const vol = (1 - t) * (1 - t);
        const pan = this.headphones3d ? Math.max(-0.75, Math.min(0.75, dx / 1600)) : 0;
        return { vol, pan };
    }

    _throttle(name, gapMs) {
        const now = performance.now();
        if (this._last[name] !== undefined && now - this._last[name] < gapMs) return false;
        this._last[name] = now;
        return true;
    }

    _busyGain() {
        if (!this.busyDuck) return 1;
        const now = performance.now();
        this._recent = this._recent.filter(t => now - t < 220);
        this._recent.push(now);
        return Math.max(0.55, 1 / Math.sqrt(Math.max(1, this._recent.length * 0.55)));
    }

    _shootDuck() {
        if (!this.busyDuck) return 1;
        const now = performance.now();
        this._shoots = this._shoots.filter(t => now - t < 160);
        this._shoots.push(now);
        return Math.max(0.2, 1 / Math.sqrt(Math.max(1, this._shoots.length * 1.1)));
    }

    // Rounded envelope: never a click. Attack is the difference between
    // "tok" and "clack".
    _out(pan, when, dur, peak, attack = 0.008) {
        const g = this.ctx.createGain();
        const a = Math.max(0.005, attack);
        const d = Math.max(a + 0.02, dur);
        g.gain.setValueAtTime(0.0001, when);
        g.gain.linearRampToValueAtTime(Math.max(0.0001, peak), when + a);
        g.gain.exponentialRampToValueAtTime(0.0001, when + d);
        let node = g;
        if (this.ctx.createStereoPanner) {
            const p = this.ctx.createStereoPanner();
            p.pan.value = pan;
            g.connect(p);
            node = p;
        }
        node.connect(this.master);
        return g;
    }

    _tone({ freq, glideTo, type = 'sine', dur = 0.1, peak = 0.2, pan = 0, delay = 0, attack = 0.008 }) {
        const t0 = this.ctx.currentTime + delay;
        const o  = this.ctx.createOscillator();
        o.type = type === 'sawtooth' || type === 'square' ? 'triangle' : type;
        const f0 = Math.max(40, jit(freq, 0.03));
        o.frequency.setValueAtTime(f0, t0);
        if (glideTo) o.frequency.exponentialRampToValueAtTime(Math.max(40, glideTo), t0 + dur);
        o.connect(this._out(pan, t0, dur, peak, attack));
        o.start(t0);
        o.stop(t0 + dur + 0.03);
    }

    // Soft air: brown (whoosh/weight) or pink (a little presence). Always
    // band-limited in the mids — never a slamming lowpass on white noise.
    _puff({ kind = 'brown', cut = 600, cutTo, Q = 0.7, dur = 0.08, peak = 0.1,
            pan = 0, delay = 0, attack = 0.01, rate = 1 } = {}) {
        const t0 = this.ctx.currentTime + delay;
        const s  = this.ctx.createBufferSource();
        s.buffer = kind === 'pink' ? this._pink : this._brown;
        s.loop = true;
        s.playbackRate.value = jit(rate, 0.08);
        const f = this.ctx.createBiquadFilter();
        f.type = 'bandpass';
        f.Q.value = Q;
        const c0 = Math.max(80, jit(cut, 0.08));
        f.frequency.setValueAtTime(c0, t0);
        if (cutTo) f.frequency.exponentialRampToValueAtTime(Math.max(80, cutTo), t0 + dur);
        s.connect(f);
        f.connect(this._out(pan, t0, dur, peak, attack));
        s.start(t0);
        s.stop(t0 + dur + 0.03);
    }

    // Quiet harmonic bloom. Slow attack so it never reads as a clack.
    _ring({ freqs = [180, 270], dur = 0.12, peak = 0.08, pan = 0, delay = 0 } = {}) {
        const d = jit(1, 0.03);
        for (let i = 0; i < freqs.length; i++) {
            this._tone({
                freq: freqs[i] * d,
                type: 'sine',
                dur: dur * (1 - i * 0.12),
                peak: peak / (i + 1.4),
                pan, delay,
                attack: 0.012,
            });
        }
    }

    // The Fortnite-style punch, stylized: felt sub + rounded body drop +
    // a whisper of brown air. Used by breaks, hurts, kills — never by chips.
    _impact({ pan = 0, v = 1, sub = 72, body = 170, bodyTo = 88, air = 480,
              weight = 0.28, dur = 0.14 } = {}) {
        this._tone({ freq: sub, glideTo: sub * 0.7, type: 'sine', dur: dur * 1.15,
                     peak: 0.22 * weight * v, pan, attack: 0.01 });
        this._tone({ freq: body, glideTo: bodyTo, type: 'sine', dur,
                     peak: 0.32 * weight * v, pan, attack: 0.008 });
        this._puff({ kind: 'brown', cut: air, cutTo: air * 0.45, Q: 0.65,
                     dur: dur * 0.85, peak: 0.12 * weight * v, pan, attack: 0.012 });
    }

    // Compatibility aliases so tutorial / console never hit the old gravel synth.
    _hiss(opts = {}) {
        this._puff({
            kind: 'brown',
            cut: opts.lowpass ? opts.lowpass * 0.45 : 550,
            dur: opts.dur, peak: (opts.peak || 0.1) * 0.6,
            pan: opts.pan, delay: opts.delay, attack: Math.max(0.01, opts.attack || 0.01),
        });
    }
    _thump(opts = {}) {
        this._impact({
            pan: opts.pan || 0, v: 1,
            body: Math.max(90, (opts.cut1 || 200) * 0.7),
            bodyTo: 70,
            air: Math.min(900, (opts.cut0 || 800) * 0.35),
            weight: (opts.peak || 0.3) * 0.7,
            dur: opts.dur || 0.1,
        });
    }


    // ── game sounds ─────────────────────────────────────────────────────────

    // Mining chip: a hollow wooden "tok". Progress brightens the body a little,
    // never the noise. Soft/graze hits are almost a murmur.
    rockHit(x, y, stage = 0, soft = false) {
        const m = this._mix('mining');
        if (!m || !this._throttle('rockHit', soft ? 140 : 70)) return;
        const sp = this._spatial(x, y);
        if (!sp) return;
        const v = sp.vol * (soft ? 0.55 : 1) * m;
        // File is much quieter than shoot; gain is volume-only so chips cut through.
        if (this._playSample('rockHit', { peak: 8 * v, pan: sp.pan, duck: false })) return;
        const st = 1 + stage * 0.07;
        this._tone({
            freq: 196 * st, glideTo: 128 * st, type: 'sine',
            dur: 0.07, peak: 0.16 * v, pan: sp.pan, attack: 0.007,
        });
        this._puff({
            kind: 'brown', cut: 620 * st, cutTo: 340, Q: 0.6,
            dur: 0.05, peak: 0.055 * v, pan: sp.pan, attack: 0.01,
        });
    }

    // Rock gone: the break WAV. Synth fallback if it has not loaded.
    rockBreak(x, y) {
        const m = this._mix('mining');
        if (!m || !this._throttle('rockBreak', 80)) return;
        const sp = this._spatial(x, y);
        if (!sp) return;
        const v = sp.vol * m;
        if (this._playSample('rockBreak', { peak: 1.65 * v, pan: sp.pan, duck: false })) return;
        this._impact({ pan: sp.pan, v, sub: 64, body: 148, bodyTo: 72,
                       air: 420, weight: 0.42, dur: 0.18 });
        this._tone({ freq: 98, type: 'sine', dur: 0.22, peak: 0.08 * v,
                     pan: sp.pan, delay: 0.04, attack: 0.02 });
    }

    // Gun: a muted air pulse. Texture in a fight, never a pew and never a clap.
    shoot(x, y, power = 1) {
        const m = this._mix('guns');
        if (!m || !this._throttle('shoot', 60)) return;
        const sp = this._spatial(x, y);
        if (!sp) return;
        const v = sp.vol * m;
        const p = Math.min(1.5, 0.55 + (power || 1) * 0.4);
        if (this._playSample('shoot', { peak: 0.28 * v * this._shootDuck(), pan: sp.pan, duck: false })) return;
        this._puff({
            kind: 'brown', cut: 520, cutTo: 280, Q: 0.75,
            dur: 0.055, peak: 0.07 * p * v, pan: sp.pan, attack: 0.008,
        });
        this._tone({
            freq: 92, glideTo: 64, type: 'sine',
            dur: 0.05, peak: 0.045 * p * v, pan: sp.pan, attack: 0.008,
        });
    }

    // Drone / swarm / minion leaving the barrel. Never used for bullets.
    droneSpawn(x, y) {
        const m = this._mix('drones');
        if (!m || !this._throttle('droneSpawn', 90)) return;
        const sp = this._spatial(x, y);
        if (!sp) return;
        if (this._playSample('droneSpawn', { peak: 0.48 * sp.vol * m, pan: sp.pan, rate: 1.28, duck: false })) return;
        this._puff({
            kind: 'brown', cut: 380, cutTo: 160, Q: 0.6,
            dur: 0.09, peak: 0.06 * sp.vol * m, pan: sp.pan, attack: 0.012,
        });
        this._tone({
            freq: 148, glideTo: 92, type: 'sine',
            dur: 0.1, peak: 0.04 * sp.vol * m, pan: sp.pan, attack: 0.012,
        });
    }

    // In-game UI: settings, keybinds, options, close, chat toggle, tank upgrade.
    uiClick() {
        const m = this._mix('ui');
        if (!global.gameStart || !m || !this._throttle('uiClick', 70)) return;
        if (this._playSample('uiClick', { peak: 0.7 * m, duck: false })) return;
        this._tone({ freq: 420, glideTo: 310, type: 'sine', dur: 0.04, peak: 0.05 * m, attack: 0.004 });
    }

    // Skill / build bar. Same click as the rest of the in-game UI.
    buildUpgrade() {
        this.uiClick();
    }

    // Soft air-hum while a rammer (no body guns) is moving. Not treads, not metal.
    rammerMove(amount = 0) {
        const m = this._mix('movement');
        if (!m) {
            if (this._loops.rammerMove) this._setLoopGain('rammerMove', 0.0001);
            return;
        }
        const a = Math.max(0, Math.min(1, amount));
        if (!this._buf.rammerMove) return;
        if (a < 0.02 && !this._loops.rammerMove) return;
        this._setLoopGain('rammerMove', 0.5 * a * m);
    }

    // Ore rock destroyed.
    oreBreak(x, y, tier = 1) {
        const m = this._mix('mining');
        if (!m || !this._throttle('oreBreak', 80)) return;
        const sp = this._spatial(x, y);
        if (!sp) return;
        const v = sp.vol * m;
        const t = Math.max(1, Math.min(4, tier | 0));
        if (this._playSample('oreBreak', { peak: 1.65 * v, pan: sp.pan, duck: false })) return;
        this._impact({ pan: sp.pan, v, sub: 68, body: 160, bodyTo: 80,
                       air: 500, weight: 0.36, dur: 0.16 });
        const base = 330 + t * 55;
        this._ring({
            freqs: [base, base * 1.5],
            dur: 0.22 + t * 0.03,
            peak: 0.07 * v,
            pan: sp.pan,
            delay: 0.03,
        });
    }

    // Gem: the one melodic beat. Soft bell, pentatonic chain, no hiss.
    gemPickup(combo = 0) {
        const m = this._mix('gems');
        if (!m || !this._throttle('gem', 50)) return;
        const steps = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21, 24];
        const st = steps[Math.min(combo, 4)];
        if (this._playSample('gemPickup', { peak: m, duck: false })) return;
        const f  = 659.25 * Math.pow(2, st / 12);
        this._tone({ freq: f, type: 'sine', dur: 0.16, peak: 0.12 * m, attack: 0.01 });
        this._tone({ freq: f * 1.5, type: 'sine', dur: 0.12, peak: 0.035 * m, delay: 0.012, attack: 0.014 });
    }

    // Vault trickle: a tiny wooden clock tick.
    depositTick() {
        const m = this._mix('depositing');
        if (!m || !this._throttle('depositTick', 40)) return;
        if (this._playSample('depositTick', { peak: m })) return;
        this._tone({ freq: 246, glideTo: 196, type: 'sine', dur: 0.04, peak: 0.055 * m, attack: 0.006 });
    }

    depositDone() {
        const m = this._mix('depositing');
        if (!m || !this._throttle('depositDone', 400)) return;
        if (this._playSample('depositDone', { peak: m, duck: false })) return;
        this._impact({ sub: 70, body: 132, bodyTo: 78, air: 380, weight: 0.38 * m, dur: 0.18 });
        this._tone({ freq: 392, type: 'sine', dur: 0.28, peak: 0.09 * m, delay: 0.08, attack: 0.02 });
        this._tone({ freq: 494, type: 'sine', dur: 0.26, peak: 0.055 * m, delay: 0.14, attack: 0.024 });
    }

    satchelFull() {
        const m = this._mix('gems');
        if (!m || !this._throttle('satchelFull', 1500)) return;
        if (this._playSample('satchelFull', { peak: m, delay: 0, duck: false })) {
            this._playSample('satchelFull', { peak: m, delay: 0.22, duck: false });
            this._playSample('satchelFull', { peak: m, delay: 0.44, duck: false });
            return;
        }
        this._tone({ freq: 164, glideTo: 110, type: 'sine', dur: 0.09, peak: 0.14 * m, attack: 0.008 });
        this._tone({ freq: 174, glideTo: 116, type: 'sine', dur: 0.11, peak: 0.16 * m, delay: 0.14, attack: 0.008 });
    }

    // ── The satchel heartbeat ───────────────────────────────────────────────
    //
    // Every other sound in this engine is a one-shot fired by an event. This
    // is the only one that is a continuous STATE: it says "you are carrying
    // something you can lose" for exactly as long as that is true, and it gets
    // more frightened the richer you are. Call it every frame with the current
    // satchel load; it schedules its own beats.
    satchelTension(load = 0) {
        const t = Math.max(0, Math.min(1, (load - TENSION_START) / (1 - TENSION_START)));
        if (t <= 0) { this._heartAt = 0; this._heartGap = 0; return; }
        const now = performance.now();
        // smoothstep, not linear: the last third of the satchel is where the
        // panic actually sets in. A flat ramp reads as a metronome.
        const gap = HEART_SLOW + (HEART_FAST - HEART_SLOW) * (t * t * (3 - 2 * t));
        this._heartGap = gap;
        if (!this._heartAt) this._heartAt = now;
        if (now < this._heartAt) return;
        this._heartAt = now + gap;
        // The clock above runs even with the category muted, because the
        // vignette throbs off satchelPulse() and must not freeze or drift just
        // because the player turned this sound down.
        const m = this._mix('satchel');
        if (!m) return;
        const peak = (0.05 + 0.20 * t) * m;
        // lub-dub. The second beat is softer, lower and close behind the first,
        // the way a real one is - two tones, no sample, costs nothing.
        this._tone({ freq: 62, glideTo: 40, type: 'sine', dur: 0.16,
                     peak, attack: 0.006 });
        this._tone({ freq: 54, glideTo: 36, type: 'sine', dur: 0.20,
                     peak: peak * 0.62, delay: 0.155, attack: 0.006 });
    }

    // 0..1, how far the heart is through its current beat. The vignette reads
    // this instead of running its own sine, so the screen throbs on exactly
    // the beat you hear rather than slowly drifting against it.
    satchelPulse() {
        if (!this._heartAt || !this._heartGap) return 0;
        const left = this._heartAt - performance.now();
        return Math.max(0, Math.min(1, 1 - left / this._heartGap));
    }

    // The sound of losing it: fires when the satchel is emptied by DEATH, not
    // by banking. Deliberately the inverse of the pickup chime - that one
    // climbs a pentatonic ladder, this one falls off it and lands on a thud.
    satchelLoss(load = 1) {
        this._heartAt = 0;
        this._heartGap = 0;
        const m = this._mix('satchel');
        if (!m) return;
        const v = Math.max(0.3, Math.min(1, load));
        for (let i = 0; i < 5; i++) {
            this._tone({ freq: 523.25 / Math.pow(2, i / 3.2), glideTo: 70,
                         type: 'sine', dur: 0.34,
                         peak: 0.13 * v * m * (1 - i * 0.14), delay: i * 0.05,
                         attack: 0.008 });
        }
        this._impact({ v, sub: 56, body: 128, bodyTo: 58, air: 320,
                       weight: 0.55 * m, dur: 0.5 });
    }

    die(x, y, size = 20) {
        const m = this._mix('deaths');
        if (!m) return;
        const sp = this._spatial(x, y);
        if (!sp) return;
        if (size <= 22) {
            if (!this._throttle('dieS', 70)) return;
            const v = sp.vol * this._busyGain() * m;
            this._puff({ kind: 'brown', cut: 480, cutTo: 240, dur: 0.05,
                         peak: 0.06 * v, pan: sp.pan, attack: 0.012 });
        } else if (size <= 55) {
            if (!this._throttle('dieM', 140)) return;
            const v = sp.vol * this._busyGain() * m;
            if (this._playSample('dieOnScreen', { peak: sp.vol * m, pan: sp.pan, duck: false })) return;
            this._impact({ pan: sp.pan, v, sub: 80, body: 150, bodyTo: 90,
                           air: 400, weight: 0.26, dur: 0.12 });
        } else {
            if (!this._throttle('dieL', 180)) return;
            const v = sp.vol * this._busyGain() * m;
            if (this._playSample('dieOnScreen', { peak: sp.vol * m, pan: sp.pan, duck: false })) return;
            this._impact({ pan: sp.pan, v, sub: 58, body: 128, bodyTo: 64,
                           air: 360, weight: 0.4, dur: 0.2 });
        }
    }

    combatHit(tier = 0) {
        const m = this._mix('combat');
        if (!m || !this._throttle('combatHit', 45)) return;
        const t = Math.max(0, Math.min(2, tier | 0));
        const v = this._busyGain() * m;
        if (this._playSample('combatHit', { peak: m })) return;
        const f = 620 + t * 90;
        this._tone({ freq: f, glideTo: f * 0.82, type: 'sine',
                     dur: 0.055 + t * 0.015, peak: 0.09 * v, attack: 0.006 });
        this._puff({ kind: 'pink', cut: 900, cutTo: 520, Q: 0.7,
                     dur: 0.035, peak: 0.04 * v, attack: 0.008 });
        if (t >= 2) this._tone({ freq: f * 1.5, type: 'sine', dur: 0.07,
                                 peak: 0.035 * v, delay: 0.01, attack: 0.01 });
    }

    // You took a hit. Gettinghit.wav — also kept quiet.
    combatHurt(frac = 0.3) {
        const m = this._mix('combat');
        if (!m || !this._throttle('combatHurt', 60)) return;
        const f = Math.max(0.15, Math.min(1, frac));
        const v = this._busyGain() * m;
        if (this._playSample('combatHurt', { peak: m })) return;
        this._impact({
            v, sub: 62, body: 120 + 20 * f, bodyTo: 68,
            air: 340, weight: 0.22 + 0.22 * f, dur: 0.12 + f * 0.06,
        });
    }

    // You got the kill: deeper bloom + a short warm lift. Satisfying, not mean.
    combatKill() {
        const m = this._mix('combat');
        if (!m || !this._throttle('combatKill', 180)) return;
        if (this._playSample('combatKill', { peak: m, duck: false })) return;
        this._impact({ sub: 56, body: 138, bodyTo: 66, air: 380, weight: 0.48 * m, dur: 0.2 });
        this._tone({ freq: 246, type: 'sine', dur: 0.16, peak: 0.08 * m, delay: 0.05, attack: 0.016 });
        this._tone({ freq: 330, type: 'sine', dur: 0.2, peak: 0.05 * m, delay: 0.1, attack: 0.02 });
    }

    bankCelebrate() {
        const m = this._mix('celebration');
        if (!m || !this._throttle('bankCelebrate', 400)) return;
        if (this._playSample('bankCelebrate', { peak: 1.45 * m, duck: false })) return;
        this._tone({ freq: 98, type: 'sine', dur: 0.18, peak: 0.1 * m, attack: 0.016 });
        this._tone({ freq: 392, type: 'sine', dur: 0.28, peak: 0.1 * m, delay: 0.04, attack: 0.02 });
        this._tone({ freq: 494, type: 'sine', dur: 0.3, peak: 0.07 * m, delay: 0.1, attack: 0.024 });
        this._tone({ freq: 587, type: 'sine', dur: 0.34, peak: 0.045 * m, delay: 0.16, attack: 0.03 });
    }

    // ── Ranked ──────────────────────────────────────────────────────────────
    // The ceremony's beats. Same rounded vocabulary: a crack is a dry tok with
    // a glassy tick on top (brighter each stage), the shatter is an impact
    // with a spill of falling ticks, the rank-up is a warm major lift that
    // opens up an octave for a whole new tier.
    rankCrack(stage = 1) {
        const m = this._mix('celebration');
        if (!m || !this._throttle('rankCrack', 90)) return;
        const s = Math.max(1, Math.min(3, stage | 0));
        this._impact({ sub: 80, body: 190 + s * 20, bodyTo: 110, air: 700, weight: (0.18 + s * 0.05) * m, dur: 0.09 });
        this._tone({ freq: 880 + s * 160, glideTo: 620 + s * 90, type: 'sine', dur: 0.05, peak: 0.05 * m, delay: 0.005, attack: 0.004 });
        this._puff({ kind: 'pink', cut: 1500, cutTo: 900, Q: 0.9, dur: 0.04, peak: 0.035 * m, attack: 0.006 });
    }

    rankShatter() {
        const m = this._mix('celebration');
        if (!m || !this._throttle('rankShatter', 300)) return;
        this._impact({ sub: 60, body: 150, bodyTo: 70, air: 520, weight: 0.5 * m, dur: 0.22 });
        this._puff({ kind: 'brown', cut: 900, cutTo: 300, Q: 0.6, dur: 0.3, peak: 0.1 * m, attack: 0.01 });
        // the bits landing: quick bright ticks falling in pitch
        const notes = [1318, 1175, 988, 1109, 880, 784];
        for (let i = 0; i < notes.length; i++) {
            this._tone({ freq: notes[i], glideTo: notes[i] * 0.86, type: 'sine', dur: 0.05,
                         peak: 0.04 * m * (1 - i * 0.1), delay: 0.04 + i * 0.045 + Math.random() * 0.02, attack: 0.004 });
        }
    }

    rankUp(big = false) {
        const m = this._mix('celebration');
        if (!m || !this._throttle('rankUp', 600)) return;
        this._impact({ sub: 55, body: 130, bodyTo: 62, air: 360, weight: (big ? 0.62 : 0.5) * m, dur: 0.26 });
        // G major lift; a new tier climbs on to the octave and rings longer
        const notes = big ? [392, 494, 587, 784, 988] : [392, 494, 587, 784];
        for (let i = 0; i < notes.length; i++) {
            this._tone({ freq: notes[i], type: 'sine', dur: (big ? 0.42 : 0.32) + i * 0.03,
                         peak: (0.1 - i * 0.012) * m, delay: 0.05 + i * 0.075, attack: 0.018 });
        }
        this._ring({ freqs: [big ? 1175 : 988, big ? 1568 : 1318], dur: big ? 0.7 : 0.5, peak: 0.05 * m, delay: 0.05 + notes.length * 0.075 });
        if (big) this._playSample('bankCelebrate', { peak: 0.7 * m, delay: 0.12, duck: false });
    }

    // Rank points going down (a fare). Soft on purpose: it is a small loss.
    rankDown() {
        const m = this._mix('celebration');
        if (!m || !this._throttle('rankDown', 800)) return;
        this._tone({ freq: 392, glideTo: 370, type: 'sine', dur: 0.16, peak: 0.06 * m, attack: 0.016 });
        this._tone({ freq: 330, glideTo: 294, type: 'sine', dur: 0.24, peak: 0.05 * m, delay: 0.12, attack: 0.02 });
    }

    // Gemdust: a tiny high bell for a pop, a two-note rise when it banks.
    dustPop() {
        const m = this._mix('gems');
        if (!m || !this._throttle('dustPop', 120)) return;
        this._tone({ freq: 1319, type: 'sine', dur: 0.12, peak: 0.06 * m, attack: 0.008 });
        this._tone({ freq: 1976, type: 'sine', dur: 0.09, peak: 0.022 * m, delay: 0.01, attack: 0.01 });
    }

    dustBank() {
        const m = this._mix('gems');
        if (!m || !this._throttle('dustBank', 300)) return;
        this._tone({ freq: 880, type: 'sine', dur: 0.14, peak: 0.06 * m, attack: 0.01 });
        this._tone({ freq: 1175, type: 'sine', dur: 0.2, peak: 0.055 * m, delay: 0.08, attack: 0.012 });
        this._puff({ kind: 'pink', cut: 1200, cutTo: 2000, Q: 0.8, dur: 0.12, peak: 0.02 * m, attack: 0.02 });
    }
}

export const gameSound = new GameSound();
window.gameSound = gameSound;
