// Raid bots are regulars for the whole raid, like players: a bot that dies
// comes back as itself (name, colour, tank, ability, board row with its
// banked gems and score) after a respawn delay, through the normal spawn.
// A new bot (new name) only fills a slot nobody is waiting to come back to.
// The next raid starts a fresh roster.
//
// ROYALE_BOT_ROSTER=0: a dead bot's slot is refilled by a new bot again
// (still after the delay, never inside the storm's spawn lock).
'use strict';

// players wait 3 s; bots a little longer, and not all at once
const DELAY_MS = 4500, DELAY_JITTER_MS = 2500;

let enabled = process.env.ROYALE_BOT_ROSTER !== '0';
function setEnabled(v) { enabled = !!v; }
function isEnabled() { return enabled; }

// waiting identities, oldest death first
const waiting = [];
// the earliest moment any new bot may appear (a death never refills instantly)
let holdUntil = 0;

function release(entry) {
    try { require('../../lib/random.js').releaseBotName(entry.nameKey); } catch { /* */ }
}

// A raid bot just died (or was trimmed away). Returns true when it is kept
// for a respawn (its name stays reserved).
function onBotGone(bot, t = Date.now(), why = '') {
    const delay = DELAY_MS + Math.random() * DELAY_JITTER_MS;
    holdUntil = Math.max(holdUntil, t + delay * 0.6);
    if (!enabled || !bot || bot.isTeamBot || why === 'raidend') return false;
    if (waiting.some(w => w.familyId === bot.botFamilyId)) return true;
    waiting.push({
        familyId: bot.botFamilyId ?? bot.id,
        nameKey: bot.botNameKey,
        name: bot.name,
        team: bot.team,
        color: bot.color && bot.color.base,
        tank: bot.defs && bot.defs[0] != null ? String(bot.defs[0]) : null,
        ability: bot.botAbility || null,
        skill: bot.botSkill, temperament: bot.botTemperament, style: bot.botStyle,
        readyAt: t + delay,
    });
    return true;
}

// May the raid add a bot right now? (respawn lock and death hold aside)
function mayFill(t = Date.now()) { return t >= holdUntil; }

// The identity to bring back now, or null. `fresh` is true when there is no
// one waiting at all (only then does a new bot get a new name).
function next(t = Date.now()) {
    if (!waiting.length) return { entry: null, fresh: true };
    let best = -1;
    for (let i = 0; i < waiting.length; i++) if (waiting[i].readyAt <= t && (best < 0 || waiting[i].readyAt < waiting[best].readyAt)) best = i;
    if (best < 0) return { entry: null, fresh: false };
    return { entry: waiting.splice(best, 1)[0], fresh: false };
}

// The raid can hold fewer bots than are waiting (the circle closed): keep
// the newest `cap` waiting, let the rest go.
function trimTo(cap) {
    while (waiting.length > Math.max(0, cap)) release(waiting.shift());
}

function resetRaid() {
    for (const w of waiting) release(w);
    waiting.length = 0;
    holdUntil = 0;
}

function size() { return waiting.length; }

module.exports = { DELAY_MS, DELAY_JITTER_MS, onBotGone, mayFill, next, trimTo, resetRaid, size, setEnabled, isEnabled, _waiting: waiting };
