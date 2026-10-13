'use strict';

const S = require('../../game/terrain/aoSchedule.js');

let cache = { at: 0, body: null };
const CACHE_MS = 5_000;

function build(now) {
    const on = process.env.ROYALE_ALWAYS_ON === '1';
    const out = { on, day: S.dayKey(now), resetIn: Math.max(0, S.nextResetAt(now) - now), champs: [], top: [] };
    if (!on) return out;
    let ds = null;
    try { ds = require('../dailyScores'); } catch (e) { return out; }
    if (!ds.available()) return out;
    try {
        const y = S.dayKey(now - S.DAY_MS);
        let champs = ds.champs(y);
        if (!champs.length) {
            const prev = ds.champs(S.dayKey(now));
            if (prev.length) champs = prev;
        }
        out.champs = champs.slice(0, 3).map(c => ({ place: c.place | 0, name: String(c.name || 'Unnamed').slice(0, 24), score: c.score | 0 }));
        out.top = ds.top(out.day, 3).map(r => ({ name: String(r.name || 'Unnamed').slice(0, 24), score: r.score | 0 }));
    } catch (e) { }
    return out;
}

function getChampions(ctx) {
    const now = Date.now();
    if (!cache.body || now - cache.at > CACHE_MS) cache = { at: now, body: build(now) };
    ctx.json(200, { ...cache.body, resetIn: Math.max(0, S.nextResetAt(now) - now) });
}

function register(router) {
    router.add('GET', '/api/champions', getChampions, { alwaysOn: true });
}

module.exports = { register, build };
