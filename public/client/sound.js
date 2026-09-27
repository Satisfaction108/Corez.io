// Corez sound system.
//
// Every sound is a real file in public/sounds/sfx/<family>/<name>_v<n>.mp3,
// generated from code by scripts/sfx/build.js (regenerate with
// `node scripts/sfx/build.js`, QA with `node scripts/sfx/analyze.js`).
// The library is one palette: D major pentatonic for anything melodic,
// crystalline chimes that climb per gem tier, chunky stone for rock,
// mechanical punch for guns, soft bubble pops for UI.
//
// Playback is plain Web Audio:
//   source -> gain -> (panner) -> category bus -> world/front bus -> master
//   -> soft limiter -> speakers
// World categories (guns, mining, combat, deaths, drones, movement) share a
// bus that big moments (kill, rank up, raid end...) duck for a beat.
// Every event has a cooldown, a voice cap, pitch/volume jitter and round-robin
// variants, so 30 shots a second stays texture instead of a machine gun.
//
// Console: gameSound.play('kill'), gameSound.setVolume(0..1), gameSound.mute(),
//          gameSound.events() lists every event name.
import { global } from "./global.js";
import { gui } from "./socketinit.js";

const VOLUME_KEY = 'dw_soundVolume';
const PREFS_KEY = 'dw_soundPrefs';
const LIB = '/sounds/sfx/';

// Slider ids are kept from the old system so saved prefs carry over; new
// categories just start at their defaults.
const MIX_CATS = [
    { id: 'combat',      label: 'Combat Hits' },
    { id: 'deaths',      label: 'Explosions' },
    { id: 'guns',        label: 'Guns' },
    { id: 'drones',      label: 'Drones' },
    { id: 'mining',      label: 'Mining' },
    { id: 'gems',        label: 'Gems' },
    { id: 'depositing',  label: 'Banking' },
    { id: 'celebration', label: 'Big Moments & Rank' },
    { id: 'events',      label: 'Raid Events & Storm' },
    { id: 'ui',          label: 'Menu & Upgrades' },
    { id: 'movement',    label: 'Drill Engine' },
    { id: 'satchel',     label: 'Satchel Tension' },
];
const WORLD_CATS = new Set(['guns', 'drones', 'mining', 'combat', 'deaths', 'movement']);

// ── the event table ────────────────────────────────────────────────────────
// name -> { f: family, file, n: variants, cat, vol, pj: pitch jitter (±),
//           vj: volume jitter (±), cd: cooldown ms, max: voices, pri, duck }
// duck: [depth 0..1, hold ms] applied to the world bus when it plays.
const EVENTS = {};
function ev(name, f, file, n, cat, vol, o = {}) {
    EVENTS[name] = {
        f, file, n, cat, vol,
        pj: o.pj ?? 0.035, vj: o.vj ?? 0.08, cd: o.cd ?? 40, max: o.max ?? 3,
        pri: o.pri ?? 1, duck: o.duck || null, early: !!o.early,
    };
}
// weapons (early = preloaded first)
ev('shotLight',  'weapons', 'shot_light',   4, 'guns',   0.55, { cd: 30, max: 6, pj: 0.05, early: true });
ev('shotMG',     'weapons', 'shot_mg',      4, 'guns',   0.5,  { cd: 25, max: 6, pj: 0.06, early: true });
ev('shotCannon', 'weapons', 'shot_cannon',  3, 'guns',   0.7,  { cd: 60, max: 4, pj: 0.04, early: true });
ev('shotSniper', 'weapons', 'shot_sniper',  3, 'guns',   0.6,  { cd: 60, max: 4, early: true });
ev('shotTrap',   'weapons', 'shot_trap',    3, 'guns',   0.55, { cd: 45, max: 4, early: true });
ev('droneLaunch','weapons', 'drone_launch', 3, 'drones', 0.5,  { cd: 70, max: 4, early: true });
// combat
ev('hitT0',      'combat', 'hit_t0',      3, 'combat', 0.6,  { cd: 35, max: 3, pj: 0.03, early: true });
ev('hitT1',      'combat', 'hit_t1',      2, 'combat', 0.65, { cd: 35, max: 3, pj: 0.03, early: true });
ev('hitT2',      'combat', 'hit_t2',      2, 'combat', 0.7,  { cd: 35, max: 3, pj: 0.02, early: true });
ev('hurtLight',  'combat', 'hurt_light',  3, 'combat', 0.7,  { cd: 55, max: 2, early: true });
ev('hurtHeavy',  'combat', 'hurt_heavy',  2, 'combat', 0.8,  { cd: 55, max: 2, early: true });
ev('kill',       'combat', 'kill',        2, 'combat', 0.85, { cd: 150, max: 2, pj: 0.01, pri: 3, duck: [0.55, 500], early: true });
ev('streak',     'combat', 'streak',      1, 'celebration', 0.75, { cd: 800, pj: 0, pri: 3, duck: [0.6, 700] });
ev('shutdown',   'combat', 'shutdown',    1, 'celebration', 0.8,  { cd: 800, pj: 0, pri: 3, duck: [0.55, 800] });
ev('revenge',    'combat', 'revenge',     1, 'celebration', 0.8,  { cd: 800, pj: 0, pri: 3, duck: [0.55, 800] });
ev('lowHealth',  'combat', 'low_health',  1, 'combat', 0.55, { cd: 4000, pj: 0, pri: 2 });
ev('shieldUp',   'combat', 'shield_up',   1, 'combat', 0.5,  { cd: 1500, pj: 0.01, pri: 2 });
ev('shieldBreak','combat', 'shield_break',1, 'combat', 0.6,  { cd: 1000, pj: 0.02, pri: 2 });
ev('death',      'combat', 'death',       1, 'celebration', 0.85, { cd: 2000, pj: 0, pri: 3, duck: [0.35, 1400] });
ev('spawn',      'combat', 'spawn',       1, 'celebration', 0.6,  { cd: 2000, pj: 0, pri: 3 });
ev('dieSmall',   'combat', 'die_small',   3, 'deaths', 0.35, { cd: 60, max: 3, pj: 0.08, early: true });
ev('dieMed',     'combat', 'die_med',     2, 'deaths', 0.7,  { cd: 110, max: 3, pj: 0.06, early: true });
ev('dieLarge',   'combat', 'die_large',   2, 'deaths', 0.85, { cd: 160, max: 2, pj: 0.05 });
// mining
ev('rockHit',    'mining', 'rock_hit',    4, 'mining', 0.6,  { cd: 55, max: 4, pj: 0.06, early: true });
for (let t = 1; t <= 4; t++) ev('oreHit' + t, 'mining', 'ore_hit_t' + t, 2, 'mining', 0.6, { cd: 55, max: 4, pj: 0.015, early: true });
ev('rockBreak',  'mining', 'rock_break',  3, 'mining', 0.75, { cd: 70, max: 4, pj: 0.06, early: true });
for (let t = 1; t <= 4; t++) ev('oreBreak' + t, 'mining', 'ore_break_t' + t, 1, 'mining', 0.8, { cd: 80, max: 3, pj: 0.01, early: true });
ev('rockRegrow', 'mining', 'rock_regrow', 2, 'mining', 0.4,  { cd: 250, max: 2, pj: 0.05 });
ev('chestLand',  'mining', 'chest_land',  1, 'mining', 0.7,  { cd: 150, max: 2, pj: 0.04 });
ev('chestOpen',  'mining', 'chest_open',  1, 'celebration', 0.75, { cd: 200, max: 2, pj: 0.02, pri: 2, duck: [0.7, 400] });
ev('chestOpenEpic','mining','chest_open_epic', 1, 'celebration', 0.8, { cd: 200, max: 2, pj: 0, pri: 3, duck: [0.55, 700] });
// gems & satchel
for (let t = 1; t <= 4; t++) ev('gem' + t, 'gems', 'gem_t' + t, 2, 'gems', 0.65, { cd: 45, max: 4, pj: 0.004, vj: 0.05, early: true });
ev('satchelFull','gems', 'satchel_full',  1, 'gems', 0.75, { cd: 1500, pj: 0, pri: 2, early: true });
ev('satchelLoss','gems', 'satchel_loss',  1, 'satchel', 0.85, { cd: 1500, pj: 0, pri: 3, duck: [0.45, 900] });
ev('heartbeat',  'gems', 'heartbeat',     1, 'satchel', 0.8, { cd: 250, pj: 0, vj: 0, max: 2 });
ev('dustPop',    'gems', 'dust_pop',      1, 'gems', 0.5,  { cd: 110, pj: 0.02 });
ev('dustBank',   'gems', 'dust_bank',     1, 'gems', 0.6,  { cd: 300, pj: 0 });
// banking
ev('depositTick','bank', 'deposit_tick',  3, 'depositing', 0.5, { cd: 45, max: 3, pj: 0.004, early: true });
ev('depositDone','bank', 'deposit_done',  1, 'depositing', 0.8, { cd: 400, pj: 0, pri: 2, duck: [0.65, 500], early: true });
ev('bankCelebrate','bank','bank_celebrate', 1, 'celebration', 0.8, { cd: 400, pj: 0, pri: 3, duck: [0.5, 900] });
// raid events / storm / boss
ev('outpostCapture','events','outpost_capture', 1, 'events', 0.75, { cd: 800, pj: 0, pri: 3, duck: [0.55, 700] });
ev('chamberOpen','events', 'chamber_open', 1, 'events', 0.75, { cd: 800, pj: 0, pri: 3, duck: [0.55, 900] });
ev('bossSurface','events', 'boss_surface', 1, 'events', 0.85, { cd: 3000, pj: 0, pri: 3, duck: [0.5, 1200] });
ev('bossDefeat', 'events', 'boss_defeat',  1, 'events', 0.85, { cd: 3000, pj: 0, pri: 3, duck: [0.4, 1500] });
ev('stormWarning','events','storm_warning', 1, 'events', 0.65, { cd: 5000, pj: 0, pri: 2 });
ev('stormShrink','events', 'storm_shrink', 1, 'events', 0.7,  { cd: 5000, pj: 0, pri: 2, duck: [0.7, 900] });
ev('stormFinal', 'events', 'storm_final',  1, 'events', 0.8,  { cd: 5000, pj: 0, pri: 3, duck: [0.5, 1400] });
ev('stormEnter', 'events', 'storm_enter',  1, 'events', 0.6,  { cd: 1200, pj: 0.03, pri: 2 });
ev('stormExit',  'events', 'storm_exit',   1, 'events', 0.5,  { cd: 1200, pj: 0.02 });
ev('raidTwist',  'events', 'raid_twist',   1, 'events', 0.75, { cd: 3000, pj: 0, pri: 3, duck: [0.6, 900] });
ev('raidStart',  'events', 'raid_start',   1, 'events', 0.8,  { cd: 5000, pj: 0, pri: 3, duck: [0.5, 1000] });
ev('raidEnd',    'events', 'raid_end',     1, 'celebration', 0.85, { cd: 5000, pj: 0, pri: 3, duck: [0.35, 2000] });
ev('countTick',  'events', 'count_tick',   1, 'events', 0.6,  { cd: 500, pj: 0 });
ev('countGo',    'events', 'count_go',     1, 'events', 0.7,  { cd: 800, pj: 0, pri: 2 });
ev('bloomStart', 'events', 'bloom_start',  1, 'events', 0.7,  { cd: 5000, pj: 0, pri: 2, duck: [0.7, 800] });
ev('meteorWarn', 'events', 'meteor_warn',  1, 'events', 0.65, { cd: 3000, pj: 0.02, pri: 2 });
ev('meteorImpact','events','meteor_impact', 1, 'deaths', 0.85, { cd: 120, max: 3, pj: 0.06 });
ev('gemRain',    'events', 'gem_rain',     1, 'events', 0.7,  { cd: 5000, pj: 0, pri: 2 });
ev('questComplete','events','quest_complete', 1, 'celebration', 0.75, { cd: 600, pj: 0, pri: 3, duck: [0.65, 600] });
ev('milestone',  'events', 'milestone',    1, 'celebration', 0.75, { cd: 600, pj: 0, pri: 3, duck: [0.6, 700] });
ev('placeUp',    'events', 'place_up',     1, 'events', 0.6,  { cd: 800, pj: 0 });
ev('placeDown',  'events', 'place_down',   1, 'events', 0.5,  { cd: 800, pj: 0 });
// progression
ev('levelUp',    'progress', 'level_up',     1, 'ui', 0.6,  { cd: 1200, pj: 0, pri: 2 });
ev('statUp',     'progress', 'stat_up',      3, 'ui', 0.55, { cd: 40, max: 3, pj: 0, early: true });
ev('tankUpgrade','progress', 'tank_upgrade', 1, 'ui', 0.75, { cd: 800, pj: 0, pri: 3, duck: [0.6, 700] });
ev('shopBuy',    'progress', 'shop_buy',     1, 'ui', 0.75, { cd: 200, pj: 0.01, pri: 2 });
ev('shopDenied', 'progress', 'shop_denied',  1, 'ui', 0.6,  { cd: 200, pj: 0 });
// rank ceremony
ev('rankCrack1', 'rank', 'rank_crack1', 1, 'celebration', 0.7, { cd: 80, pj: 0.01 });
ev('rankCrack2', 'rank', 'rank_crack2', 1, 'celebration', 0.7, { cd: 80, pj: 0.01 });
ev('rankCrack3', 'rank', 'rank_crack3', 1, 'celebration', 0.7, { cd: 80, pj: 0.01 });
ev('rankShatter','rank', 'rank_shatter',1, 'celebration', 0.8, { cd: 300, pj: 0, pri: 3 });
ev('rankUp',     'rank', 'rank_up',     1, 'celebration', 0.85, { cd: 600, pj: 0, pri: 3, duck: [0.4, 1600] });
ev('rankUpBig',  'rank', 'rank_up_big', 1, 'celebration', 0.85, { cd: 600, pj: 0, pri: 3, duck: [0.35, 2200] });
ev('rankDown',   'rank', 'rank_down',   1, 'celebration', 0.6, { cd: 800, pj: 0 });
// UI
ev('uiClick',    'ui', 'ui_click',      3, 'ui', 0.6,  { cd: 55, max: 2, pj: 0.02, early: true });
ev('uiHover',    'ui', 'ui_hover',      1, 'ui', 0.5,  { cd: 45, max: 1, pj: 0.03, early: true });
ev('uiTab',      'ui', 'ui_tab',        1, 'ui', 0.6,  { cd: 55, max: 2, pj: 0.02, early: true });
ev('uiToggleOn', 'ui', 'ui_toggle_on',  1, 'ui', 0.6,  { cd: 55, max: 2, pj: 0, early: true });
ev('uiToggleOff','ui', 'ui_toggle_off', 1, 'ui', 0.6,  { cd: 55, max: 2, pj: 0, early: true });
ev('uiPlay',     'ui', 'ui_play',       1, 'ui', 0.75, { cd: 600, pj: 0, pri: 3, early: true });
ev('uiSuccess',  'ui', 'ui_success',    1, 'ui', 0.6,  { cd: 150, pj: 0 });
ev('uiError',    'ui', 'ui_error',      1, 'ui', 0.6,  { cd: 150, pj: 0 });
ev('notify',     'ui', 'notify',        1, 'ui', 0.65, { cd: 400, pj: 0, pri: 2 });
// loops
const LOOPS = { drill: { f: 'loops', file: 'drill_loop', len: 2.0, cat: 'movement' } };

// Pentatonic steps (semitones) for pitch ladders: gem combos, deposit ticks,
// stat clicks. Same key as the library, so a ladder never sounds off.
const LADDER = [0, 2, 4, 7, 9, 12, 14, 16];
const semis = (s) => Math.pow(2, s / 12);

// ── satchel tension (the heartbeat) ────────────────────────────────────────
const TENSION_START = 0.30;
const HEART_SLOW = 1180;
const HEART_FAST = 430;

const MAX_VOICES = 40;

function defaultPrefs() {
    const cats = {}, catOn = {};
    for (const c of MIX_CATS) { cats[c.id] = 1; catOn[c.id] = true; }
    let vol = parseFloat(localStorage.getItem(VOLUME_KEY));
    if (isNaN(vol)) vol = 0.7;
    return { enabled: true, headphones3d: true, volume: vol, busyDuck: true, farSounds: true, muteHidden: true, cats, catOn };
}
function loadPrefs() {
    const d = defaultPrefs();
    try {
        const raw = JSON.parse(localStorage.getItem(PREFS_KEY) || 'null');
        if (!raw || typeof raw !== 'object') return d;
        for (const k of ['enabled', 'headphones3d', 'busyDuck', 'farSounds', 'muteHidden'])
            if (typeof raw[k] === 'boolean') d[k] = raw[k];
        if (typeof raw.volume === 'number') d.volume = Math.max(0, Math.min(1, raw.volume));
        for (const c of MIX_CATS) {
            const n = parseFloat(raw.cats && raw.cats[c.id]);
            if (!isNaN(n)) d.cats[c.id] = Math.max(0, Math.min(1, n));
            if (raw.catOn && typeof raw.catOn[c.id] === 'boolean') d.catOn[c.id] = raw.catOn[c.id];
        }
    } catch (e) { /* keep defaults */ }
    return d;
}

class GameSound {
    constructor() {
        this.ctx = null;
        this._bufs = {};        // event -> [{ buf, lead }] (sparse while loading)
        this._loading = {};
        this._voices = [];      // live { src, gain, name, end, pri }
        this._evState = {};     // event -> { last, lastV, voices: [] }
        this._catBus = {};
        this._loop = null;
        this._shoots = [];
        this._warned = new Set();
        this._gunKind = new Map();
        this._clsCache = new Map();
        this._w = null;         // state watcher memory
        this._statRun = { at: 0, step: 0 };
        this.tensionStart = TENSION_START;
        const p = loadPrefs();
        Object.assign(this, { enabled: p.enabled, headphones3d: p.headphones3d, volume: p.volume, busyDuck: p.busyDuck,
            farSounds: p.farSounds, muteHidden: p.muteHidden, cats: p.cats, catOn: p.catOn });
        this._tabHidden = false;
        this._hookGesture();
        this._hookUiClicks();
        this._hookPrefsUi();
        this._hookToasts();
    }

    // ── setup ──────────────────────────────────────────────────────────────
    _hookGesture() {
        const kick = () => {
            this._init();
            if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
        };
        for (const e of ['pointerdown', 'keydown', 'touchstart'])
            document.addEventListener(e, kick, { passive: true, capture: true });
    }

    _init() {
        if (this.ctx) return;
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        try { this.ctx = new AC({ latencyHint: 'interactive' }); } catch (e) { try { this.ctx = new AC(); } catch (e2) { return; } }
        const c = this.ctx;
        // gentle safety limiter: only touches the rare pile-up
        this._comp = c.createDynamicsCompressor();
        this._comp.threshold.value = -6;
        this._comp.knee.value = 4;
        this._comp.ratio.value = 12;
        this._comp.attack.value = 0.002;
        this._comp.release.value = 0.15;
        this._master = c.createGain();
        this._world = c.createGain();    // duckable
        this._front = c.createGain();
        this._world.connect(this._master);
        this._front.connect(this._master);
        this._master.connect(this._comp);
        this._comp.connect(c.destination);
        for (const cat of MIX_CATS) {
            const g = c.createGain();
            g.connect(WORLD_CATS.has(cat.id) ? this._world : this._front);
            this._catBus[cat.id] = g;
        }
        this._applyMaster();
        this._loadAll();
    }

    _url(e, v) { return `${LIB}${e.f}/${e.file}_v${v + 1}.mp3`; }

    async _fetchBuf(url) {
        const res = await fetch(url);
        if (!res.ok) throw new Error(res.status + ' ' + url);
        const arr = await res.arrayBuffer();
        const buf = await new Promise((ok, bad) => {
            const p = this.ctx.decodeAudioData(arr, ok, bad);
            if (p && p.then) p.then(ok, bad);
        });
        // MP3 encoders pad the start; some browsers leave that silence in.
        // Skip it so hits land on the frame they were triggered.
        const d = buf.getChannelData(0), lim = Math.min(d.length, Math.floor(buf.sampleRate * 0.08));
        let i = 0;
        while (i < lim && Math.abs(d[i]) < 0.002) i++;
        const lead = i >= lim ? 0 : Math.max(0, i - Math.floor(buf.sampleRate * 0.0005)) / buf.sampleRate;
        return { buf, lead };
    }

    _load(name) {
        const e = EVENTS[name];
        if (!e || this._loading[name] || !this.ctx) return this._loading[name];
        this._bufs[name] = new Array(e.n);
        this._loading[name] = Promise.all(Array.from({ length: e.n }, (_, v) =>
            this._fetchBuf(this._url(e, v)).then((b) => { this._bufs[name][v] = b; })
                .catch((err) => { if (!this._warned.has(name)) { this._warned.add(name); console.warn('sfx: could not load', name, err && err.message); } })
        ));
        return this._loading[name];
    }

    async _loadAll() {
        // frequent sounds first, the rest right behind, a few at a time
        const early = Object.keys(EVENTS).filter((n) => EVENTS[n].early);
        const late = Object.keys(EVENTS).filter((n) => !EVENTS[n].early);
        const run = async (list, par) => {
            let i = 0;
            await Promise.all(Array.from({ length: par }, async () => { while (i < list.length) await this._load(list[i++]); }));
        };
        await run(early, 6);
        this._loadLoops();
        await run(late, 4);
    }

    async _loadLoops() {
        for (const [key, L] of Object.entries(LOOPS)) {
            try { L.data = await this._fetchBuf(`${LIB}${L.f}/${L.file}_v1.mp3`); }
            catch (e) { console.warn('sfx: could not load loop', key); }
        }
    }

    // ── mix state ──────────────────────────────────────────────────────────
    _live() { return this.enabled && this.volume > 0 && !(this.muteHidden && this._tabHidden); }

    _applyMaster() {
        if (this._master) {
            const t = this.ctx.currentTime;
            this._master.gain.cancelScheduledValues(t);
            this._master.gain.setTargetAtTime(this._live() ? this.volume : 0, t, 0.02);
            for (const c of MIX_CATS) {
                const g = this._catBus[c.id];
                if (g) g.gain.setTargetAtTime(this.catOn[c.id] === false ? 0 : (this.cats[c.id] ?? 1), t, 0.02);
            }
        }
        const pane = document.getElementById('sp-sound');
        if (pane) pane.classList.toggle('is-muted', !this.enabled);
    }

    _mix(cat) {
        if (!this._live() || !this.ctx || this.ctx.state !== 'running') return 0;
        if (cat && this.catOn[cat] === false) return 0;
        return cat ? (this.cats[cat] ?? 1) : 1;
    }
    _ready(cat) { return this._mix(cat) > 0; }

    _savePrefs() {
        try {
            localStorage.setItem(PREFS_KEY, JSON.stringify({
                enabled: this.enabled, headphones3d: this.headphones3d, volume: this.volume, busyDuck: this.busyDuck,
                farSounds: this.farSounds, muteHidden: this.muteHidden, cats: { ...this.cats }, catOn: { ...this.catOn },
            }));
            localStorage.setItem(VOLUME_KEY, this.volume);
        } catch (e) { /* private mode */ }
    }

    setVolume(v) { this.volume = Math.max(0, Math.min(1, v)); this._savePrefs(); this._applyMaster(); }
    mute() { this.setVolume(0); }
    events() { return Object.keys(EVENTS); }

    // Duck the world bus (guns, mining, hits...) so a big moment reads.
    duck(depth = 0.5, holdMs = 600) {
        if (!this._world) return;
        const g = this._world.gain, t = this.ctx.currentTime;
        g.cancelScheduledValues(t);
        g.setTargetAtTime(depth, t, 0.03);
        g.setTargetAtTime(1, t + holdMs / 1000, 0.25);
    }

    _spatial(x, y) {
        const lx = global.player ? global.player.renderx : 0;
        const ly = global.player ? global.player.rendery : 0;
        const dx = x - lx, dy = y - ly, d = Math.hypot(dx, dy);
        const MAXD = this.farSounds ? 3200 : 1400;
        if (!isFinite(d) || d > MAXD) return null;
        const t = Math.max(0, (d - 500) / (MAXD - 500));
        const vol = (1 - t) * (1 - t);
        const pan = this.headphones3d ? Math.max(-0.75, Math.min(0.75, dx / 1600)) : 0;
        return { vol, pan };
    }

    _shootDuck() {
        if (!this.busyDuck) return 1;
        const now = performance.now();
        this._shoots = this._shoots.filter((t) => now - t < 160);
        this._shoots.push(now);
        return Math.max(0.3, 1 / Math.sqrt(Math.max(1, this._shoots.length * 0.8)));
    }

    // ── the one playback path ──────────────────────────────────────────────
    // opts: x,y (world pos -> distance + pan), pan, vol, rate, delay, force
    play(name, o = {}) {
        try { return this._play(name, o); } catch (e) { return false; }
    }
    at(name, x, y, o = {}) { return this.play(name, { ...o, x, y }); }

    _play(name, o) {
        const e = EVENTS[name];
        if (!e || !this._mix(e.cat)) return false;
        let pan = o.pan || 0, sv = 1;
        if (o.x !== undefined && o.y !== undefined) {
            const sp = this._spatial(o.x, o.y);
            if (!sp) return false;
            sv = sp.vol; pan = sp.pan;
        }
        const st = this._evState[name] || (this._evState[name] = { last: -1e9, lastV: -1, voices: [] });
        const now = performance.now();
        if (!o.force && now - st.last < e.cd) return false;
        const set = this._bufs[name];
        if (!set) { this._load(name); return false; }
        const ready = [];
        for (let i = 0; i < set.length; i++) if (set[i]) ready.push(i);
        if (!ready.length) return false;
        // round-robin-ish: random, never the same variant twice in a row
        let vi = ready[Math.floor(Math.random() * ready.length)];
        if (ready.length > 1 && vi === st.lastV) vi = ready[(ready.indexOf(vi) + 1) % ready.length];
        st.lastV = vi;
        const b = set[vi], c = this.ctx, t0 = c.currentTime + Math.max(0, o.delay || 0);
        // voice management: per event cap (steal the oldest), then global cap
        const ct = c.currentTime;
        st.voices = st.voices.filter((v) => v.end > ct);
        this._voices = this._voices.filter((v) => v.end > ct);
        if (st.voices.length >= e.max) this._stop(st.voices.shift());
        if (this._voices.length >= MAX_VOICES) {
            const victim = this._voices.find((v) => v.pri < e.pri) || (e.pri >= 3 ? this._voices[0] : null);
            if (!victim) return false;
            this._stop(victim);
        }
        st.last = now;
        const rate = Math.max(0.25, Math.min(4, (o.rate || 1) * (1 + (Math.random() * 2 - 1) * e.pj)));
        const vol = e.vol * (o.vol ?? 1) * sv * (1 + (Math.random() * 2 - 1) * e.vj);
        if (!(vol > 0.0005)) return false;
        const src = c.createBufferSource();
        src.buffer = b.buf;
        src.playbackRate.value = rate;
        const g = c.createGain();
        g.gain.value = Math.min(2, vol);
        src.connect(g);
        let out = g;
        if (pan && c.createStereoPanner) {
            const p = c.createStereoPanner();
            p.pan.value = Math.max(-1, Math.min(1, pan));
            g.connect(p);
            out = p;
        }
        out.connect(this._catBus[e.cat] || this._front);
        src.start(t0, b.lead);
        const voice = { src, gain: g, name, pri: e.pri, end: t0 + (b.buf.duration - b.lead) / rate };
        src.onended = () => { try { out.disconnect(); } catch (err) { /* */ } };
        st.voices.push(voice);
        this._voices.push(voice);
        if (e.duck) this.duck(e.duck[0], e.duck[1]);
        return true;
    }

    _stop(v) {
        if (!v) return;
        try {
            const t = this.ctx.currentTime;
            v.gain.gain.cancelScheduledValues(t);
            v.gain.gain.setTargetAtTime(0, t, 0.006);
            v.src.stop(t + 0.04);
        } catch (e) { /* already stopped */ }
        v.end = 0;
    }

    // ── weapons ────────────────────────────────────────────────────────────
    // Which sound a barrel makes, read from its mockup geometry once and
    // cached: drones, traps (short flared cap), machine guns (flared barrel),
    // cannons (wide), snipers (long + narrow), everything else light.
    _gunSound(z, gi) {
        const idx = z && z.index;
        if (idx == null || !global.mockups) return 'shotLight';
        const key = idx + ':' + gi;
        const hit = this._gunKind.get(key);
        if (hit) return hit;
        let g = null, n = 0;
        for (const part of String(idx).split('-')) {
            const mock = global.mockups[parseInt(part, 10)];
            if (!mock || !mock.guns) continue;
            if (gi < n + mock.guns.length) { g = mock.guns[gi - n]; break; }
            n += mock.guns.length;
        }
        let kind = 'shotLight';
        if (g) {
            const L = +g.length || 18, W = +g.width || 8, A = +g.aspect || 1;
            if (g.drone) kind = 'droneLaunch';
            else if (L <= 7 && A >= 1.3) kind = 'shotTrap';
            else if (A >= 1.25) kind = 'shotMG';
            else if (W >= 11) kind = 'shotCannon';
            else if (L >= 21 && W <= 9.5) kind = 'shotSniper';
        }
        if (this._gunKind.size > 4000) this._gunKind.clear();
        this._gunKind.set(key, kind);
        return kind;
    }

    shoot(x, y, power = 1, z = null, gi = 0) {
        const kind = this._gunSound(z, gi);
        const mine = z && gui && z.id === gui.playerid;
        const v = (mine ? 1 : 0.75) * this._shootDuck() * (0.85 + Math.min(0.3, (power || 1) * 0.1));
        this.play(kind, { x, y, vol: v });
    }
    droneSpawn(x, y) { this.play('droneLaunch', { x, y }); }

    // ── combat ─────────────────────────────────────────────────────────────
    combatHit(tier = 0) { this.play('hitT' + Math.max(0, Math.min(2, tier | 0))); }
    combatHurt(frac = 0.3) {
        const f = Math.max(0.1, Math.min(1, frac));
        this.play(f > 0.5 ? 'hurtHeavy' : 'hurtLight', { vol: 0.65 + 0.35 * f });
    }
    combatKill() { this.play('kill'); }
    die(x, y, size = 20) {
        if (size <= 22) this.play('dieSmall', { x, y });
        else if (size <= 55) this.play('dieMed', { x, y });
        else this.play('dieLarge', { x, y });
    }
    // Big centre callouts (KC packet kinds from the server).
    callout(kind) {
        const k = String(kind || '');
        if (k === 'quest') this.play('questComplete');
        else if (k === 'streak') this.play('streak', { delay: 0.18 });
        else if (k === 'shutdown') this.play('shutdown', { delay: 0.18 });
        else if (k === 'revenge') this.play('revenge', { delay: 0.18 });
        else if (k === 'boss') { if (performance.now() - (this._bossDeadAt || 0) > 2500) this.play('bossDefeat'); }
        else if (k === 'late') this.play('notify');
    }

    // ── mining ─────────────────────────────────────────────────────────────
    // stage: crack stage of the cell (0..3) - the chip brightens as it goes.
    // soft: a graze. tier: ore tier of the cell (0 = plain rock).
    rockHit(x, y, stage = 0, soft = false, tier = 0) {
        const t = Math.max(0, Math.min(4, tier | 0));
        const rate = (1 + Math.max(0, stage | 0) * 0.035) * (soft ? 0.93 : 1);
        const vol = (soft ? 0.55 : 1) * this._shootDuckMining();
        this.play(t ? 'oreHit' + t : 'rockHit', { x, y, rate, vol });
    }
    _shootDuckMining() { return this.busyDuck ? Math.max(0.55, 1 - Math.max(0, this._shoots.length - 2) * 0.08) : 1; }
    rockBreak(x, y) { this.play('rockBreak', { x, y }); }
    oreBreak(x, y, tier = 1) { this.play('oreBreak' + Math.max(1, Math.min(4, tier | 0)), { x, y }); }
    rockRegrow(x, y) { this.play('rockRegrow', { x, y }); }
    chestLand(x, y) { this.play('chestLand', { x, y }); }
    // Server FX packet kinds.
    fx(kind, x, y) {
        if (kind === 'meteor' || kind === 'charge') this.play('meteorImpact', { x, y });
        else if (kind === 'bossdead') { this._bossDeadAt = performance.now(); this.play('bossDefeat'); this.play('dieLarge', { x, y, force: true }); }
        else if (kind === 'chest') this.play('chestOpen', { x, y });
        else if (kind === 'chestrare') this.play('chestOpenEpic', { x, y });
    }

    // Engine hum while a rammer (no guns) is driving. Called every frame -
    // it also drives the state watcher (spawn, storm, level ups...).
    rammerMove(amount = 0) {
        this._watch();
        const L = LOOPS.drill;
        const a = Math.max(0, Math.min(1, amount));
        if (!this.ctx || !L.data) return;
        if (!this._loop) {
            if (a < 0.02) return;
            const s = this.ctx.createBufferSource();
            s.buffer = L.data.buf;
            s.loop = true;
            s.loopStart = L.data.lead;
            s.loopEnd = Math.min(L.data.buf.duration, L.data.lead + L.len);
            const g = this.ctx.createGain();
            g.gain.value = 0;
            s.connect(g);
            g.connect(this._catBus[L.cat]);
            s.start(0, L.data.lead);
            this._loop = { src: s, gain: g };
        }
        const t = this.ctx.currentTime;
        const target = this._live() ? 0.55 * a : 0;
        this._loop.gain.gain.setTargetAtTime(target, t, 0.08);
        this._loop.src.playbackRate.setTargetAtTime(0.88 + 0.24 * a, t, 0.15);
    }

    // ── gems / satchel / banking ───────────────────────────────────────────
    // Which gem did we just eat? The nearest gem entity to the player (dying
    // ones first) - the GEM packet itself carries no tier.
    _clsOf(e) {
        const idx = e && e.index;
        if (idx == null || !global.mockups) return '';
        let c = this._clsCache.get(idx);
        if (c === undefined) {
            const m = global.mockups[parseInt(String(idx).split('-')[0], 10)];
            c = (m && m.className) || '';
            this._clsCache.set(idx, c);
        }
        return c;
    }
    _gemTier() {
        const ents = global.entities;
        if (!ents || !global.player) return 1;
        const px = global.player.renderx, py = global.player.rendery;
        let best = '', bd = 320 * 320;
        for (const e of ents) {
            const cls = this._clsOf(e);
            if (!cls.startsWith('gemPickup')) continue;
            const x = e.render ? e.render.x : e.x, y = e.render ? e.render.y : e.y;
            let d2 = (x - px) * (x - px) + (y - py) * (y - py);
            try { if (e.render && e.render.status && e.render.status.getState() === 'dying') d2 *= 0.25; } catch (err) { /* */ }
            if (d2 < bd) { bd = d2; best = cls; }
        }
        return { gemPickupCopper: 1, gemPickupVein: 2, gemPickupShard: 3, gemPickupEmerald: 4 }[best] || 1;
    }
    gemPickup(combo = 0, tier = 0) {
        const t = tier || this._gemTier();
        this.play('gem' + t, { rate: semis(LADDER[Math.min(Math.max(0, combo | 0), 5)]) });
    }
    satchelFull() { this.play('satchelFull'); }
    satchelLoss(load = 1) {
        this._heartAt = 0; this._heartGap = 0;
        this.play('satchelLoss', { vol: Math.max(0.45, Math.min(1, load)) });
    }
    // Ticks climb the pentatonic ladder as the vault fills.
    depositTick() {
        const v = global.vault || {};
        const prog = v.total > 0 ? Math.max(0, Math.min(1, 1 - (v.remaining || 0) / v.total)) : 0;
        this.play('depositTick', { rate: semis(LADDER[Math.min(5, Math.floor(prog * 6))]) });
    }
    depositDone() { this.play('depositDone'); }
    bankCelebrate() { this.play('bankCelebrate'); }
    dustPop() { this.play('dustPop'); }
    dustBank() { this.play('dustBank'); }

    // The satchel heartbeat: a continuous state, called every frame with the
    // satchel load. Schedules its own beats; the vignette reads satchelPulse().
    satchelTension(load = 0) {
        const t = Math.max(0, Math.min(1, (load - TENSION_START) / (1 - TENSION_START)));
        if (t <= 0) { this._heartAt = 0; this._heartGap = 0; return; }
        const now = performance.now();
        const gap = HEART_SLOW + (HEART_FAST - HEART_SLOW) * (t * t * (3 - 2 * t));
        this._heartGap = gap;
        if (!this._heartAt) this._heartAt = now;
        if (now < this._heartAt) return;
        this._heartAt = now + gap;
        this.play('heartbeat', { vol: 0.25 + 0.75 * t, rate: 1 + 0.06 * t, force: true });
    }
    satchelPulse() {
        if (!this._heartAt || !this._heartGap) return 0;
        const left = this._heartAt - performance.now();
        return Math.max(0, Math.min(1, 1 - left / this._heartGap));
    }

    // ── events / progression / rank ────────────────────────────────────────
    outpostCapture() { this.play('outpostCapture'); }
    chamberOpen() { this.play('chamberOpen'); }
    bossSurface() { this.play('bossSurface'); }
    raidEnd() { this.play('raidEnd'); }
    shopResult(ok) { this.play(ok ? 'shopBuy' : 'shopDenied'); }
    placeChange(up) { this.play(up ? 'placeUp' : 'placeDown'); }
    notify() { this.play('notify'); }
    // Stat clicks climb a little ladder while you spam them.
    buildUpgrade() {
        const now = performance.now(), r = this._statRun;
        r.step = now - r.at < 650 ? Math.min(5, r.step + 1) : 0;
        r.at = now;
        this.play('statUp', { rate: semis(LADDER[r.step]) });
    }
    uiClick() { this.play('uiClick'); }
    rankCrack(stage = 1) { this.play('rankCrack' + Math.max(1, Math.min(3, stage | 0))); }
    rankShatter() { this.play('rankShatter'); }
    rankUp(big = false) { this.play(big ? 'rankUpBig' : 'rankUp'); }
    rankDown() { this.play('rankDown'); }

    // ── state watcher ──────────────────────────────────────────────────────
    // Moments with no packet of their own are read off client state, 10x a
    // second: spawn/death, spawn shield, low health, level up, tank upgrade,
    // storm phases, blooms, raid events, overrides, raid countdown.
    _watch() {
        const now = performance.now();
        if (this._watchAt && now - this._watchAt < 100) return;
        this._watchAt = now;
        if (!this.ctx) return;
        try { this._watchInner(now); } catch (e) { /* never break the frame */ }
    }
    _watchInner(now) {
        const g = global, w = this._w || (this._w = { alive: false, spawnAt: 0 });
        const alive = !!(g.gameStart && !g.died && !g.disconnected);
        if (alive && !w.alive) { w.spawnAt = now; w.lvl = null; w.type = null; w.inv = null; w.hp = 1; if (!g.tutorial) this.play('spawn'); }
        if (!alive && w.alive && g.died) this.play('death');
        w.alive = alive;
        const settled = now - w.spawnAt > 1500;
        if (alive && gui) {
            const me = g.entities && g.entities.find((e) => e.id === gui.playerid);
            if (me) {
                const inv = !!me.invuln;
                if (w.inv === false && inv) this.play('shieldUp');
                if (w.inv === true && !inv) this.play('shieldBreak');
                if (w.inv === null && inv) this.play('shieldUp', { delay: 0.35 });
                w.inv = inv;
                const hp = typeof me.health === 'number' ? me.health : 1;
                if (hp < 0.3 && w.hp >= 0.3 && hp > 0) this.play('lowHealth');
                w.hp = hp;
            }
            const lvl = gui.__s && gui.__s.getLevel ? gui.__s.getLevel() : 0;
            if (w.lvl != null && lvl > w.lvl && settled) this.play('levelUp', { vol: 0.8 });
            w.lvl = lvl;
            if (w.type != null && gui.type && gui.type !== w.type && settled) this.play('tankUpgrade');
            w.type = gui.type;
        }
        const r = g.royale;
        if (!r || !g.gameStart) return;
        const st = r.storm;
        if (st && st.a) {
            if (st.hold && st.left > 0 && st.left <= 10 && w.warnC !== st.c) { w.warnC = st.c; this.play('stormWarning'); }
            if (w.hold === 1 && !st.hold && w.cyc === st.c) this.play('stormShrink');
            if (st.lock && w.lock === 0) this.play('stormFinal');
            w.hold = st.hold ? 1 : 0; w.cyc = st.c; w.lock = st.lock ? 1 : 0;
            if (alive && g.player && st.r > 0) {
                const d = Math.hypot(g.player.renderx - (st.cx || 0), g.player.rendery - (st.cy || 0));
                if (!w.inStorm && d > st.r + 10) { w.inStorm = true; this.play('stormEnter'); }
                else if (w.inStorm && d < st.r - 30) { w.inStorm = false; this.play('stormExit'); }
            } else w.inStorm = false;
        }
        const bloomOn = !!r.bloom;
        if (bloomOn && w.bloom === false) this.play('bloomStart');
        w.bloom = bloomOn;
        const evKey = r.event ? r.event.kind + ':' + (r.event.liveAt || r.event.x) : '';
        if (evKey && w.evKey !== undefined && evKey !== w.evKey) this.play(r.event.kind === 'rain' ? 'gemRain' : 'meteorWarn');
        w.evKey = evKey;
        const modId = r.mod && r.mod.id ? r.mod.id : '';
        if (modId && modId !== w.mod) this.play('raidTwist', { delay: w.mod === undefined ? 1.8 : 0 });
        w.mod = modId;
        // between raids: 3-2-1 then GO when the next raid id arrives
        if (r.ending && r.nextIn > 0 && r.nextIn <= 3 && w.count !== r.nextIn) this.play('countTick', { rate: semis(r.nextIn === 1 ? 4 : r.nextIn === 2 ? 2 : 0) });
        w.count = r.ending ? r.nextIn : 0;
        const rid = r.raidId | 0;
        if (rid && w.rid && rid !== w.rid) { this.play('countGo'); this.play('raidStart', { delay: 0.12 }); }
        w.rid = rid || w.rid;
    }

    // ── DOM hooks: clicks, hovers, toggles, toasts ─────────────────────────
    _hookUiClicks() {
        const SEL = 'button, .sp-tab, b[data-key], input[type=checkbox], input[type=range], select, label, [role=tab], #homeSettingsClose, #homeSettingsOverlay';
        document.addEventListener('click', (e) => {
            const el = e.target && e.target.closest && e.target.closest(SEL);
            if (!el) return;
            if (el.tagName === 'CANVAS' || (el.id && el.id.startsWith('gameCanvas'))) return;
            if (el.id === 'startButton') { this.play('uiPlay'); return; }
            // a label click is followed by a synthetic click on its input
            if (el.tagName === 'LABEL' && el.querySelector('input')) return;
            if (el.tagName === 'INPUT' && el.type === 'checkbox') { this.play(el.checked ? 'uiToggleOn' : 'uiToggleOff'); return; }
            if (el.matches('.dw-nav-btn, .sp-tab, [role=tab]')) { this.play('uiTab'); return; }
            if (el.disabled || el.getAttribute('aria-disabled') === 'true') { this.play('uiError'); return; }
            this.play('uiClick');
        }, true);
        document.addEventListener('pointerover', (e) => {
            if (global.gameStart || e.pointerType === 'touch') return;
            const el = e.target && e.target.closest && e.target.closest('#startButton, .dw-nav-btn, .social-btn');
            if (!el || (e.relatedTarget && el.contains(e.relatedTarget))) return;
            this.play('uiHover');
        }, { passive: true });
    }

    _hookToasts() {
        const onNode = (n) => {
            if (!n || n.nodeType !== 1 || !n.classList) return;
            if (n.classList.contains('toast')) {
                if (n.classList.contains('error')) this.play('uiError');
                else if (n.classList.contains('ok')) this.play('uiSuccess');
                else this.play('notify');
            } else if (n.classList.contains('igc-toast-t')) this.play('notify');   // in-game friend DM
        };
        const boot = () => {
            if (!document.body || typeof MutationObserver === 'undefined') return;
            new MutationObserver((list) => {
                for (const m of list) for (const n of m.addedNodes) onNode(n);
            }).observe(document.body, { childList: true, subtree: true });
        };
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
        else boot();
    }

    _hookPrefsUi() {
        const boot = () => {
            document.addEventListener('visibilitychange', () => {
                this._tabHidden = document.hidden;
                this._applyMaster();
            });
            const pane = document.getElementById('sp-sound');
            const mixHost = document.getElementById('sfxMix');
            if (!pane || !mixHost || mixHost.dataset.ready) return;
            mixHost.dataset.ready = '1';
            mixHost.className = 'sp-mix';
            for (const c of MIX_CATS) {
                const row = document.createElement('div');
                row.className = 'sp-mix-row';
                const pct = Math.round((this.cats[c.id] ?? 1) * 100);
                row.innerHTML =
                    `<label class="container"><input class="checkbox" type="checkbox" data-sfx-on="${c.id}" ${this.catOn[c.id] ? 'checked' : ''}><span class="checkmark"></span></label>` +
                    `<span>${c.label}</span>` +
                    `<input type="range" min="0" max="100" value="${pct}" data-sfx-vol="${c.id}">` +
                    `<b data-sfx-val="${c.id}">${pct}%</b>`;
                mixHost.appendChild(row);
            }
            const $ = (id) => document.getElementById(id);
            const on = $('sfxOn'), hp = $('sfxHeadphones'), vol = $('sfxVolume'), volVal = $('sfxVolumeVal');
            const duck = $('sfxBusyDuck'), far = $('sfxFarSounds'), hide = $('sfxMuteHidden');
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
                this._applyMaster();
            });
        };
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
        else boot();
    }
}

export const gameSound = new GameSound();
window.gameSound = gameSound;
