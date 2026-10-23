'use strict';

const fs = require('fs');
const path = require('path');

const MODES = ['2tdm', 'ffa'];
const FILE = path.join(process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, '../../../data'), 'modeRotation.json');
const WARN_MS = 60_000;

let state = null;

function modeList() {
    const raw = String(process.env.ROYALE_MODES || '2tdm').toLowerCase().split(/[\s,]+/).filter(m => MODES.includes(m));
    return raw.length ? raw : ['2tdm'];
}

function blockMs() {
    const v = parseFloat(process.env.ROYALE_MODE_MIN);
    return (Number.isFinite(v) && v > 0 ? v : 30) * 60_000;
}

function load() {
    try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return null; }
}

function save() {
    if (!state) return;
    try {
        fs.mkdirSync(path.dirname(FILE), { recursive: true });
        fs.writeFileSync(FILE, JSON.stringify({ mode: state.mode, startedAt: state.startedAt }));
    } catch { /* the rotation just starts over next boot */ }
}

function eligible(cfg) {
    return !!(cfg && cfg.dig_royale && !cfg.tutorial && !cfg.royale_duos && process.env.ROYALE_ALWAYS_ON !== '0');
}

function boot(cfg) {
    if (!eligible(cfg)) { if (cfg) cfg.royale_teams = false; state = null; return null; }
    const modes = modeList();
    const t = Date.now();
    const ms = blockMs();
    const prev = load();
    let mode = modes[0];
    let startedAt = t;
    if (prev && modes.includes(prev.mode)) {
        if (modes.length === 1 || t - prev.startedAt < ms) { mode = prev.mode; startedAt = modes.length === 1 ? t : prev.startedAt; }
        else mode = modes[(modes.indexOf(prev.mode) + 1) % modes.length];
    }
    state = { mode, startedAt, modes };
    cfg.royale_teams = mode === '2tdm';
    save();
    return state;
}

function current() { return state ? state.mode : null; }
function peekMode() {
    if (state) return state.mode;
    if (process.env.ROYALE_ALWAYS_ON === '0') return 'ffa';
    const prev = load();
    const modes = modeList();
    return prev && modes.includes(prev.mode) ? prev.mode : modes[0];
}
function rotates() { return !!state && state.modes.length > 1; }
function switchAt() { return rotates() ? state.startedAt + blockMs() : Infinity; }
function nextMode() {
    if (!rotates()) return state ? state.mode : null;
    return state.modes[(state.modes.indexOf(state.mode) + 1) % state.modes.length];
}

function advance(cfg, t = Date.now()) {
    if (!state) return null;
    state.mode = nextMode();
    state.startedAt = t;
    if (cfg) cfg.royale_teams = state.mode === '2tdm';
    save();
    return state.mode;
}

function label(mode) { return mode === '2tdm' ? '2TDM' : mode === 'ffa' ? 'FFA' : ''; }

module.exports = { MODES, WARN_MS, boot, current, peekMode, rotates, switchAt, nextMode, advance, label, eligible, modeList, blockMs };
