// Daily quests: the database side (daily_quests rows).
//
// Every account gets 3 quests per UTC day, reset at 00:00 UTC: slot 0 easy
// (0.1 dust), slot 1 medium (0.2), slot 2 hard (0.4), never two on the same
// event. The pick is a pure function of (user, day, SHOP_SEED_SALT), so the
// game thread and the menu API can both create the rows (INSERT OR IGNORE)
// and always agree. Completing one credits its dust at once, exempt from the
// daily soft cap (dust_ledger kind 'quest').
//
// Progress is counted in the game thread (game/progressHooks.js) and written
// here in batches; completion is written immediately and exactly once
// (UPDATE ... WHERE completed_at IS NULL decides).
'use strict';

const nodeCrypto = require('crypto');
const db = require('./db');
const dust = require('./dust');
const config = require('./config');

const DAY = 24 * 60 * 60 * 1000;
const SLOTS = 3;
const REWARD_MILLI = { easy: 100, medium: 200, hard: 400 };
const TIER_OF_SLOT = ['easy', 'medium', 'hard'];

// event: what the game reports; mode 'add' sums amounts, 'max' keeps the
// best single value (minutes alive in one life).
const POOL = [
    { id: 'bank_3k',    tier: 'easy',   event: 'bank',       mode: 'add', goal: 3000, text: 'Bank 3,000 gems' },
    { id: 'elim_5',     tier: 'easy',   event: 'kill',       mode: 'add', goal: 5,    text: 'Eliminate 5 miners (bots count)' },
    { id: 'chests_2',   tier: 'easy',   event: 'chest',      mode: 'add', goal: 2,    text: 'Open 2 chests' },
    { id: 'elim_3p',    tier: 'medium', event: 'killPlayer', mode: 'add', goal: 3,    text: 'Eliminate 3 players' },
    { id: 'purple_10',  tier: 'medium', event: 'purple',     mode: 'add', goal: 10,   text: 'Pick up 10 purple shards' },
    { id: 'emerald_2',  tier: 'medium', event: 'emerald',    mode: 'add', goal: 2,    text: 'Pick up 2 emeralds' },
    { id: 'survive_15', tier: 'medium', event: 'survive',    mode: 'max', goal: 15,   text: 'Survive 15 minutes in one life' },
    { id: 'capture_1',  tier: 'medium', event: 'capture',    mode: 'add', goal: 1,    text: 'Capture a base' },
    { id: 'bank_8k',    tier: 'hard',   event: 'bank',       mode: 'add', goal: 8000, text: 'Bank 8,000 gems' },
    { id: 'top_10',     tier: 'hard',   event: 'top10',      mode: 'add', goal: 1,    text: 'Finish a raid in the top 10' },
    { id: 'boss_blow',  tier: 'hard',   event: 'boss',       mode: 'add', goal: 1,    text: 'Land the final blow on a boss' },
];
const BY_ID = new Map(POOL.map(q => [q.id, q]));

function h() { return db.handle(); }
function dayOf(ms = Date.now()) { return Math.floor(ms / DAY); }
function resetsAt(day) { return (day + 1) * DAY; }

// Pure: the three quest ids for (userId, day).
function assign(userId, day, salt = config.shopSeedSalt) {
    const seed = nodeCrypto.createHash('sha256').update(`dq:${salt}:${userId | 0}:${day | 0}`).digest();
    const used = new Set();
    const out = [];
    for (let slot = 0; slot < SLOTS; slot++) {
        const tier = TIER_OF_SLOT[slot];
        const opts = POOL.filter(q => q.tier === tier && !used.has(q.event));
        const q = opts[seed.readUInt32BE(slot * 4) % opts.length];
        used.add(q.event);
        out.push({ slot, id: q.id });
    }
    return out;
}

// Creates the day's rows if needed. -> rows ordered by slot
function ensure(userId, day = dayOf(), now = Date.now()) {
    const d = h();
    if (!d) return [];
    let rows = d.all('SELECT * FROM daily_quests WHERE user_id = ? AND day = ? ORDER BY slot', userId, day);
    if (rows.length >= SLOTS) return rows;
    d.tx(() => {
        for (const a of assign(userId, day)) {
            const q = BY_ID.get(a.id);
            d.run(`INSERT OR IGNORE INTO daily_quests (user_id, day, slot, quest_id, target, progress, reward_milli)
                   VALUES (?, ?, ?, ?, ?, 0, ?)`, userId, day, a.slot, q.id, q.goal, REWARD_MILLI[q.tier]);
        }
    });
    rows = d.all('SELECT * FROM daily_quests WHERE user_id = ? AND day = ? ORDER BY slot', userId, day);
    return rows;
}

function view(row) {
    const q = BY_ID.get(row.quest_id) || { text: row.quest_id };
    return {
        slot: row.slot | 0, id: row.quest_id, text: q.text, goal: row.target | 0,
        progress: Math.min(row.target | 0, row.progress | 0), rewardMilli: row.reward_milli | 0,
        done: row.completed_at != null,
    };
}

// GET /api/quests body.
function list(userId, now = Date.now()) {
    const day = dayOf(now);
    return { day, resetsAt: resetsAt(day), quests: ensure(userId, day, now).map(view) };
}

// Batched progress: [{userId, day, slot, progress}]. Never lowers progress,
// never touches a completed quest.
function saveProgress(list) {
    const d = h();
    if (!d || !list.length) return;
    d.tx(() => {
        for (const e of list) {
            d.run('UPDATE daily_quests SET progress = MAX(progress, ?) WHERE user_id = ? AND day = ? AND slot = ? AND completed_at IS NULL',
                Math.max(0, e.progress | 0), e.userId, e.day, e.slot);
        }
    });
}

// Marks a quest done and pays it, exactly once.
// -> {rewardMilli, balanceMilli} | null (already done, or gone)
function complete(userId, day, slot, now = Date.now()) {
    const d = h();
    if (!d) return null;
    return d.tx(() => {
        const row = d.get('SELECT * FROM daily_quests WHERE user_id = ? AND day = ? AND slot = ?', userId, day, slot);
        if (!row || row.completed_at != null) return null;
        const r = d.run(`UPDATE daily_quests SET progress = target, completed_at = ?, claimed_at = ?
                         WHERE user_id = ? AND day = ? AND slot = ? AND completed_at IS NULL`, now, now, userId, day, slot);
        if (!r.changes) return null;
        const reward = row.reward_milli | 0;
        const balance = reward ? dust.creditExempt(userId, reward, 'quest', `quest:${day}:${slot}:${row.quest_id}`, now) : null;
        return { rewardMilli: reward, balanceMilli: balance == null ? null : balance };
    });
}

module.exports = { DAY, SLOTS, POOL, BY_ID, REWARD_MILLI, dayOf, resetsAt, assign, ensure, view, list, saveProgress, complete };
