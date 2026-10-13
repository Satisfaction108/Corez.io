'use strict';

const DELAY_MS = 4500, DELAY_JITTER_MS = 2500;

let enabled = process.env.ROYALE_BOT_ROSTER !== '0';
function setEnabled(v) { enabled = !!v; }
function isEnabled() { return enabled; }

const waiting = [];
let holdUntil = 0;

function release(entry) {
    try { require('../../lib/random.js').releaseBotName(entry.nameKey); } catch { }
}

function onBotGone(bot, t = Date.now(), why = '') {
    const delay = DELAY_MS + Math.random() * DELAY_JITTER_MS;
    holdUntil = Math.max(holdUntil, t + delay * 0.6);
    if (why === 'logoff') { if (ao.on) forget(bot.botFamilyId ?? bot.id); return ao.on; }
    if (!enabled || !bot || bot.isTeamBot || why === 'raidend') return false;
    if (ao.on && ao.retiring.has(bot.botFamilyId ?? bot.id)) { noteLeave(bot.botFamilyId ?? bot.id, t); return false; }
    if (waiting.some(w => w.familyId === bot.botFamilyId)) return true;
    waiting.push(entryOf(bot, t, delay));
    return true;
}

const AO = {
    RETIRE_GAP_MS: 3000,
    RETIRE_FORCE_MS: 90 * 1000,
    JOIN_HOLD_MIN_MS: 3 * 1000,
    JOIN_HOLD_MAX_MS: 8 * 1000,
};
const ao = { on: false, life: new Map(), bench: [], retiring: new Map(), retired: new Set(), lastTurnAt: 0, joinHoldUntil: 0, started: 0, joins: 0, leaves: 0 };
function rand(a, b) { return a + Math.random() * (b - a); }
function setAlwaysOn(v, t = Date.now()) {
    const was = ao.on;
    ao.on = !!v;
    if (ao.on && !was) ao.started = t;
}
function forget(fam) {
    ao.life.delete(fam);
    if (ao.retiring.delete(fam)) ao.retired.add(fam);
    for (let i = ao.bench.length - 1; i >= 0; i--) if (ao.bench[i].familyId === fam) ao.bench.splice(i, 1);
}
function noteJoin(bot, t = Date.now(), back = null) {
    if (!ao.on || !bot) return null;
    const fam = bot.botFamilyId ?? bot.id;
    let life = ao.life.get(fam);
    if (!life) {
        life = { familyId: fam, name: bot.name, joinedAt: back && back.joinedAt ? back.joinedAt : t };
        ao.life.set(fam, life);
        if (!back) ao.joins++;
    }
    life.name = bot.name;
    return life;
}
function overdue(fam) { return ao.retiring.has(fam); }
function turnOpen(t) { return ao.on && ao.retiring.size > 0 && t - ao.lastTurnAt >= AO.RETIRE_GAP_MS; }
function noteLeave(fam, t) {
    forget(fam);
    ao.leaves++;
    ao.lastTurnAt = t;
    ao.joinHoldUntil = t + rand(AO.JOIN_HOLD_MIN_MS, AO.JOIN_HOLD_MAX_MS);
}
function pickLeaver(bots, t, ok = () => true) {
    if (!turnOpen(t)) return null;
    let best = null, bestSince = Infinity;
    for (const b of bots || []) {
        const since = ao.retiring.get(b.botFamilyId ?? b.id);
        if (since == null || since >= bestSince) continue;
        if (t - since < AO.RETIRE_FORCE_MS && !ok(b)) continue;
        best = b; bestSince = since;
    }
    return best;
}
function logOff(bot, t = Date.now()) {
    if (!bot) return;
    noteLeave(bot.botFamilyId ?? bot.id, t);
}
function retireAll(t = Date.now()) {
    let n = 0;
    for (const fam of [...ao.life.keys()]) {
        const wi = waiting.findIndex(w => w.familyId === fam);
        const bi = ao.bench.findIndex(w => w.familyId === fam);
        if (wi >= 0 || bi >= 0) {
            if (wi >= 0) release(waiting.splice(wi, 1)[0]);
            if (bi >= 0) release(ao.bench.splice(bi, 1)[0]);
            ao.life.delete(fam);
            ao.retired.add(fam);
            continue;
        }
        ao.retiring.set(fam, t);
        n++;
    }
    ao.lastTurnAt = t - AO.RETIRE_GAP_MS;
    return n;
}
function isRetiring(fam) { return ao.retiring.has(fam); }
function inRoster(fam) { return ao.life.has(fam) && !ao.retiring.has(fam); }
function takeRetired() {
    const out = [...ao.retired];
    ao.retired.clear();
    return out;
}
function seed(entries, t = Date.now()) {
    let n = 0;
    for (const e of entries || []) {
        if (!e || e.familyId == null || ao.life.has(e.familyId)) continue;
        try { require('../../lib/random.js').reserveBotName(e.nameKey); } catch { }
        ao.life.set(e.familyId, { familyId: e.familyId, name: e.name, joinedAt: e.joinedAt || t });
        ao.bench.push(Object.assign({}, e, { readyAt: t }));
        n++;
    }
    return n;
}
function entryOf(bot, t = Date.now(), delay = 0) {
    const fam = bot.botFamilyId ?? bot.id;
    const life = ao.on ? ao.life.get(fam) : null;
    return {
        familyId: fam,
        nameKey: bot.botNameKey,
        name: bot.name,
        team: bot.team,
        color: bot.color && bot.color.base,
        tank: bot.defs && bot.defs[0] != null ? String(bot.defs[0]) : null,
        ability: bot.botAbility || null,
        skill: bot.botSkill, temperament: bot.botTemperament, style: bot.botStyle,
        minnow: !!bot.botMinnow,
        readyAt: t + delay,
        joinedAt: life ? life.joinedAt : t,
    };
}
function identity(fam) {
    return waiting.find(w => w.familyId === fam) || ao.bench.find(w => w.familyId === fam) || null;
}
function joinOpen(t = Date.now()) { return !ao.on || t >= ao.joinHoldUntil; }
function present(fam) {
    return waiting.some(w => w.familyId === fam) || ao.bench.some(w => w.familyId === fam);
}
function aoState() {
    return { on: ao.on, lives: [...ao.life.values()].map(l => ({ fam: l.familyId, name: l.name, age: Date.now() - l.joinedAt, retiring: ao.retiring.has(l.familyId) })), bench: ao.bench.map(w => w.name), waiting: waiting.map(w => w.name), lastTurnAt: ao.lastTurnAt, joins: ao.joins, leaves: ao.leaves };
}

function mayFill(t = Date.now()) { return t >= holdUntil; }

function next(t = Date.now()) {
    if (!waiting.length) {
        if (ao.on && ao.bench.length) {
            const w = ao.bench.pop();
            w.readyAt = t;
            return { entry: w, fresh: false, benched: true };
        }
        if (ao.on && t < ao.joinHoldUntil) return { entry: null, fresh: false };
        return { entry: null, fresh: true };
    }
    let best = -1;
    for (let i = 0; i < waiting.length; i++) if (waiting[i].readyAt <= t && (best < 0 || waiting[i].readyAt < waiting[best].readyAt)) best = i;
    if (best < 0) return { entry: null, fresh: false };
    return { entry: waiting.splice(best, 1)[0], fresh: false };
}

function trimTo(cap) {
    while (waiting.length > Math.max(0, cap)) {
        const w = waiting.shift();
        if (ao.on && ao.life.has(w.familyId)) { if (!ao.bench.some(b => b.familyId === w.familyId)) ao.bench.push(w); }
        else release(w);
    }
}

function resetRaid() {
    for (const w of waiting) release(w);
    waiting.length = 0;
    holdUntil = 0;
    if (!ao.on) { for (const w of ao.bench) release(w); ao.bench.length = 0; ao.life.clear(); ao.retiring.clear(); ao.retired.clear(); }
}

function size() { return waiting.length; }

function noteCarry(bot, n) {
    if (!bot || !(n > 0)) return false;
    const fam = bot.botFamilyId ?? bot.id;
    const w = waiting.find(e => e.familyId === fam);
    if (!w) return false;
    w.carry = (w.carry | 0) + (n | 0);
    return true;
}

module.exports = { AO, setAlwaysOn, noteJoin, pickLeaver, logOff, retireAll, isRetiring, inRoster, takeRetired, seed, entryOf, identity, joinOpen, present, overdue, turnOpen, aoState, _ao: ao, DELAY_MS, DELAY_JITTER_MS, onBotGone, noteCarry, mayFill, next, trimTo, resetRaid, size, setEnabled, isEnabled, _waiting: waiting };
