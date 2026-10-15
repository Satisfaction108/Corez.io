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

function postMine(ctx) {
    ctx.limit('levels', ctx.ipKey);
    const now = Date.now(), out = { on: process.env.ROYALE_ALWAYS_ON === '1', yesterday: null, today: null };
    let ds = null;
    try { ds = require('../dailyScores'); } catch (e) { return ctx.json(200, out); }
    if (!out.on || !ds.available()) return ctx.json(200, out);
    let a = null;
    try { a = ctx.accountsOn ? ctx.auth() : null; } catch (e) { a = null; }
    const g = ctx.body && ctx.body.guestId;
    const who = a ? 'a:' + a.user.id : (typeof g === 'string' && /^[a-f0-9]{32}$/.test(g) ? 'g:' + g : null);
    if (!who) return ctx.json(200, out);
    try {
        out.yesterday = ds.placeOf(S.dayKey(now - S.DAY_MS), who);
        out.today = ds.placeOf(S.dayKey(now), who);
    } catch (e) { }
    ctx.json(200, out);
}

function register(router) {
    router.add('GET', '/api/champions', getChampions, { alwaysOn: true });
    router.add('POST', '/api/champions/me', postMine, { alwaysOn: true });
}

module.exports = { register, build };
