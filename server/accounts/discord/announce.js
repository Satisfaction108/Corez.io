// Public announcements in DISCORD_ANNOUNCE_CHANNEL_ID (main thread).
//
//   rank-ups     every division-up at Diamond I or higher; a new tier from
//                Legend up with its Legend #N
//                (bus {t:'rankUp', userId, division, tierUp} from the game)
//   raid top 3   the account holders who placed 1-3 in an eligible raid,
//                led by the Core Champion's line when that's an account
//                (bus {t:'raidTop', raidKey, raidNo, top:[{userId, place, score}],
//                champ:{userId, score}|null})
//
// Messages queue (oldest dropped past 50) and go out one at a time through
// rest.js. Usernames are markdown-escaped and mentions are off. Disabled
// unless both the bot token and the channel are set.
'use strict';

const config = require('../config');
const bus = require('../bus');
const users = require('../users');
const rankStore = require('../rankStore');
const rest = require('./rest');
const R = require('../../../shared/ranks.js');

const MAX_QUEUE = 50;
const DIAMOND_I = R.TIERS.indexOf('diamond') * 3;   // division index 12
const PLACE = ['', '1st', '2nd', '3rd'];

const queue = [];
let sending = false;
let unsub = null;
let errAt = 0;

function enabled() {
    return !!(config.discordBot.botToken && config.discordBot.announceChannelId);
}

function enqueue(content) {
    if (!enabled() || !content) return false;
    queue.push(String(content).slice(0, 1900));
    while (queue.length > MAX_QUEUE) queue.shift();
    pump();
    return true;
}

async function pump() {
    if (sending) return;
    sending = true;
    try {
        while (queue.length) {
            const content = queue.shift();
            try {
                await rest.sendMessage(config.discordBot.announceChannelId, { content });
            } catch (e) {
                const t = Date.now();
                if (t - errAt > 60000) { errAt = t; console.error('[discord] announcement failed: ' + ((e && e.message) || e)); }
            }
        }
    } finally {
        sending = false;
    }
}

// -> message text | null
function rankUpText(msg) {
    const row = users.byId(msg.userId);
    if (!row || row.ranked_at == null) return null;
    const div = msg.division == null ? R.divisionOf(row.rp | 0) : msg.division | 0;
    if (div < DIAMOND_I) return null;
    const name = rest.escapeMd(row.username);
    if (R.isLegend(div) && msg.tierUp) {
        // a new tier from Legend up, with the Legend #N
        const n = rankStore.legendRank(row, { fresh: true });
        return `**${name}** reached **${R.nameOf(div)}**${n ? ` (#${n})` : ''}! 👑`;
    }
    return `**${name}** ranked up to **${R.nameOf(div)}**${msg.tierUp ? '!' : '.'}`;
}

function raidTopText(msg) {
    const lines = [];
    // the Crown Contest's Core Champion leads, when it's an account
    let head = '';
    const ch = msg.champ && msg.champ.userId ? users.byId(msg.champ.userId) : null;
    if (ch) {
        const pts = (msg.champ.score | 0).toLocaleString('en-US');
        head = `👑 **${rest.escapeMd(ch.username)}** won Raid${msg.raidNo ? ' #' + (msg.raidNo | 0) : ''} with ${pts} points!`;
    }
    for (const e of (msg.top || []).slice().sort((a, b) => a.place - b.place)) {
        if (!(e.place >= 1 && e.place <= 3)) continue;
        const row = users.byId(e.userId);
        if (!row) continue;
        lines.push(`${PLACE[e.place]}: **${rest.escapeMd(row.username)}** (${(e.score | 0).toLocaleString('en-US')} pts)`);
    }
    if (head) return lines.length ? head + '\nTop finishers:\n' + lines.join('\n') : head;
    return lines.length ? 'Raid over. Top finishers:\n' + lines.join('\n') : null;
}

function onBus(serverId, msg) {
    if (!msg || !enabled()) return;
    try {
        if (msg.t === 'rankUp') enqueue(rankUpText(msg));
        else if (msg.t === 'raidTop') enqueue(raidTopText(msg));
    } catch (e) {
        console.error('[discord] announcement build failed: ' + ((e && e.stack) || e));
    }
}

function start() {
    if (!unsub) unsub = bus.onMain(onBus);
}

function stop() {
    if (unsub) unsub();
    unsub = null;
    queue.length = 0;
}

module.exports = { start, stop, enqueue, enabled, rankUpText, raidTopText, DIAMOND_I, _queue: queue };
