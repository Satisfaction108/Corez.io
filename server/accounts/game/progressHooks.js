// Daily quests + achievements in the game thread.
//
// Game events arrive from dustHooks (bank, pickup), rankHooks (kills, life
// end, raid placement, the open-life clock) and dig_royale.js (chests, base
// captures, boss final blows, streaks). Accounts only, and only while ranked
// is on (bridge.rankedOn), so a guest or a plain ROYALE_DEBUG run never
// writes anything.
//
// Packets (server -> client, JSON string):
//   DQ   {slot, id, text, progress, goal, done, rewardMilli}   one quest; all 3
//        at spawn, then on change (at most every 500 ms per quest, a
//        completion at once). A completion also sends DU kind 6 (quest dust).
//   ACH  {id, name, desc}                                      an unlock
// Unlocks also go to the main thread as {t:'ach', userId, id}, which pushes
// the 'ach' SSE event to an open menu.
//
// Progress is kept here and written every 5 s (and on close); completions and
// unlocks are written immediately.
'use strict';

const quests = require('../quests');
const achievements = require('../achievements');

const SAVE_MS = 5000;
const DQ_MIN_MS = 500;
const HOARD_AT = 3000;
const SURVIVE_QUEST_MIN = 15;
const SURVIVOR_MS = 30 * 60 * 1000;
const STREAK_AT = 5;
const ORE_PURPLE = 3;
const ORE_EMERALD = 4;

let bridgeMod = null;
function bridge() { return bridgeMod || (bridgeMod = require('./bridge')); }
function on() { try { return bridge().rankedOn(); } catch (e) { return false; } }

// userId -> {day, list:[{slot, id, event, mode, goal, progress, reward, done, dirty, dqAt, dqPending}]}
const cache = new Map();
const dqQueue = new Map();     // userId -> socket with DQ waiting
let lastSaveAt = 0;
let errAt = 0;

function logErr(what, e) {
    const t = Date.now();
    if (t - errAt < 10000) return;
    errAt = t;
    console.error('[accounts] progress ' + what + ' failed: ' + ((e && e.stack) || e));
}

function sendJson(socket, type, obj) {
    if (!socket || socket.terminated) return;
    try { socket.talk(type, JSON.stringify(obj)); } catch (e) { /* closing */ }
}

function userOf(socket) {
    return socket && socket.account && socket.account.id ? socket.account.id : 0;
}

// ---- quests ----

function load(userId, now = Date.now()) {
    const day = quests.dayOf(now);
    let c = cache.get(userId);
    if (c && c.day === day) return c;
    if (c) saveUser(c, userId);
    const rows = quests.ensure(userId, day, now);
    c = {
        day,
        list: rows.map(r => {
            const q = quests.BY_ID.get(r.quest_id) || { event: '', mode: 'add' };
            return {
                slot: r.slot | 0, id: r.quest_id, text: q.text || r.quest_id, event: q.event, mode: q.mode, goal: r.target | 0,
                progress: Math.min(r.target | 0, r.progress | 0), reward: r.reward_milli | 0, done: r.completed_at != null,
                dirty: false, dqAt: 0, dqPending: false,
            };
        }),
    };
    cache.set(userId, c);
    return c;
}

function dqOf(q) {
    return { slot: q.slot, id: q.id, text: q.text, progress: q.progress, goal: q.goal, done: q.done, rewardMilli: q.reward };
}

function sendDQ(socket, q, now) {
    q.dqPending = false;
    q.dqAt = now;
    sendJson(socket, 'DQ', dqOf(q));
}

// All three quests (spawn).
function sendAll(socket) {
    const userId = userOf(socket);
    if (!userId || !on()) return;
    try {
        const c = load(userId);
        const now = Date.now();
        for (const q of c.list) sendDQ(socket, q, now);
    } catch (e) { logErr('load', e); }
}

// A game event for this account's quests. mode 'add' adds `amount`, 'max'
// quests take `amount` as the new value if it is higher.
function bump(socket, event, amount = 1) {
    const userId = userOf(socket);
    if (!userId || !(amount > 0) || !on()) return;
    let c;
    try { c = load(userId); } catch (e) { logErr('load', e); return; }
    const now = Date.now();
    for (const q of c.list) {
        if (q.done || q.event !== event) continue;
        const next = Math.min(q.goal, q.mode === 'max' ? Math.max(q.progress, Math.floor(amount)) : q.progress + Math.floor(amount));
        if (next <= q.progress) continue;
        q.progress = next;
        if (q.progress >= q.goal) finish(socket, userId, c, q, now);
        else {
            q.dirty = true;
            q.dqPending = true;
            dqQueue.set(userId, socket);
        }
    }
}

function finish(socket, userId, c, q, now) {
    let res = null;
    try { res = quests.complete(userId, c.day, q.slot, now); } catch (e) {
        // busy: keep the progress one short so the next event retries
        logErr('complete', e);
        q.progress = Math.max(0, q.goal - 1);
        q.dirty = true;
        return;
    }
    q.done = true;
    q.dirty = false;
    sendDQ(socket, q, now);
    if (res && res.rewardMilli) {
        const dh = require('./dustHooks');
        dh.noteExternalCredit(userId, res.rewardMilli, res.balanceMilli);
        bridge().du(socket, res.rewardMilli, 6, true);
    }
}

function saveUser(c, userId) {
    const rows = [];
    for (const q of c.list) if (q.dirty && !q.done) rows.push({ userId, day: c.day, slot: q.slot, progress: q.progress });
    if (!rows.length) return true;
    try {
        quests.saveProgress(rows);
    } catch (e) { logErr('save', e); return false; }
    for (const q of c.list) q.dirty = false;
    return true;
}

function saveAll() {
    for (const [userId, c] of cache) saveUser(c, userId);
}

function tick(t = Date.now()) {
    if (dqQueue.size) {
        for (const [userId, socket] of Array.from(dqQueue)) {
            const c = cache.get(userId);
            if (!c || socket.terminated) { dqQueue.delete(userId); continue; }
            let waiting = false;
            for (const q of c.list) {
                if (!q.dqPending) continue;
                if (t - q.dqAt >= DQ_MIN_MS) sendDQ(socket, q, t);
                else waiting = true;
            }
            if (!waiting) dqQueue.delete(userId);
        }
    }
    if (t - lastSaveAt >= SAVE_MS) {
        lastSaveAt = t;
        saveAll();
    }
}

function onClose(socket) {
    const userId = userOf(socket);
    if (!userId) return;
    dqQueue.delete(userId);
    const c = cache.get(userId);
    if (c && saveUser(c, userId)) cache.delete(userId);
}

// ---- achievements ----

function notifyAch(socket, userId, id) {
    const def = achievements.BY_ID.get(id);
    if (!def) return;
    sendJson(socket, 'ACH', { id, name: def.name, desc: def.desc });
    try { require('../index').bus.toMain({ t: 'ach', userId, id }); } catch (e) { /* main gone */ }
}

function unlockEvent(socket, id) {
    const userId = userOf(socket);
    if (!userId || !on()) return;
    const c = socket._achHave || (socket._achHave = new Set());
    if (c.has(id)) return;
    try {
        if (achievements.unlock(userId, id)) notifyAch(socket, userId, id);
        c.add(id);
    } catch (e) { logErr('unlock', e); }
}

// After user_stats moved (life settled, placement, dust flush).
function checkStats(socket, userId) {
    userId = userId || userOf(socket);
    if (!userId || !on()) return;
    try {
        for (const id of achievements.checkStats(userId)) notifyAch(socket, userId, id);
    } catch (e) { logErr('stats', e); }
}

// ---- game events ----

function onBank(socket, gems) {
    bump(socket, 'bank', Math.floor(gems));
}

function onPickup(body, gem) {
    const socket = body && body.socket;
    if (!userOf(socket) || !gem) return;
    if (gem.gemOre === ORE_PURPLE) bump(socket, 'purple', 1);
    else if (gem.gemOre === ORE_EMERALD) {
        bump(socket, 'emerald', 1);
        if (on() && !(socket._achHave && socket._achHave.has('emerald_eye'))) {
            try {
                const r = achievements.addProgress(socket.account.id, 'emerald_eye', 1);
                if (r.unlocked) notifyAch(socket, socket.account.id, 'emerald_eye');
            } catch (e) { logErr('emerald', e); }
        }
    }
    if ((body.carriedGems | 0) >= HOARD_AT) unlockEvent(socket, 'hoarder');
}

// A kill that passed the ranked filters (not a spawn kill, not a farmed victim).
function onKill(socket, victimIsBot) {
    if (!userOf(socket)) return;
    bump(socket, 'kill', 1);
    if (!victimIsBot) {
        bump(socket, 'killPlayer', 1);
        unlockEvent(socket, 'first_blood');
    }
}

function onStreak(body, streak) {
    if (body && body.socket && (streak | 0) >= STREAK_AT) unlockEvent(body.socket, 'streaker');
}

function onChest(body) { if (body && body.socket) bump(body.socket, 'chest', 1); }
function onCapture(body) { if (body && body.socket) bump(body.socket, 'capture', 1); }
function onBoss(body) {
    if (!body || !body.socket) return;
    bump(body.socket, 'boss', 1);
    unlockEvent(body.socket, 'boss_slayer');
}

// The open-life clock (rankHooks, every few seconds, living bodies only).
function onAlive(body, aliveMs) {
    const socket = body && body.socket;
    if (!userOf(socket)) return;
    const min = Math.floor(aliveMs / 60000);
    if (min >= 1) bump(socket, 'survive', Math.min(SURVIVE_QUEST_MIN, min));
    if (aliveMs >= SURVIVOR_MS) unlockEvent(socket, 'survivor');
    if ((body.carriedGems | 0) >= HOARD_AT) unlockEvent(socket, 'hoarder');
}

// A life settled (socket may be gone: a disconnect settles later).
function afterLife(socket, userId, reason, durationMs) {
    if (socket && reason !== 'disconnect') {
        const min = Math.floor(Math.max(0, durationMs) / 60000);
        if (min >= 1) bump(socket, 'survive', Math.min(SURVIVE_QUEST_MIN, min));
        if (durationMs >= SURVIVOR_MS) unlockEvent(socket, 'survivor');
    }
    checkStats(socket, userId);
}

// A raid placement was paid (res from rankStore.applyRaidPlacement).
function afterPlacement(socket, userId, res) {
    if (socket && res && res.eligible && res.place <= 10) bump(socket, 'top10', 1);
    checkStats(socket, userId);
}

module.exports = {
    SAVE_MS, load, sendAll, bump, tick, saveAll, onClose, checkStats, unlockEvent,
    onBank, onPickup, onKill, onStreak, onChest, onCapture, onBoss, onAlive, afterLife, afterPlacement,
    _cache: cache,
};
