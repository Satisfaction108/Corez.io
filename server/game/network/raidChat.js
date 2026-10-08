// Raid chat: every line goes once to every client in this raid server (the
// chat panel under the standings reads it), not just the tanks on screen.
//
//   'CH' [id, bodyId, name, color, text, team 0/1]
//
// color is the speaker's compiled body colour (body.color.compiled); the
// client resolves it with gameDraw.modifyColor, like an entity's colour.
// Rules: a block either way hides the line from both; a team line reaches
// only that team; "$toggle" (socket.status.disablechat) mutes it; tutorial
// learners only hear their own plot. Players' lines go through fromPlayer:
// the 'chatMessage' event first (spam limits, commands), then the shared
// profanity mask. Bots talk through Entity.say -> send.
'use strict';

const profanity = require('../../../shared/profanity.js');

const MAX_LEN = 120;   // a hard cap on what goes out (the spam filter says 56 for players)
let seq = 0;

// Hooks (tests swap these): who is in the raid, and the account block check.
const hooks = {
    clients: () => (global.gameManager && global.gameManager.clients) || [],
    // viewer's account blocks the speaker (accounts/game/bridge.js)
    chatHidden: (viewer, speaker) => {
        try { return require('../../accounts/game/bridge.js').chatHidden(viewer, speaker); } catch { return false; }
    },
};

function tidy(text) {
    // one line, no control characters, trimmed
    return String(text == null ? '' : text).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
}

function teamOf(socket) {
    const p = socket && socket.player;
    if (!p) return undefined;
    return p.body ? p.body.team : p.team;
}

function accountIdOf(socket) {
    return (socket && socket.account && socket.account.id) || 0;
}

// a block either way: the viewer blocked the speaker, or the speaker blocked the viewer
function blocked(viewer, body, speakerSocket) {
    if (body && body.accountId && hooks.chatHidden(viewer, body)) return true;
    const vid = accountIdOf(viewer);
    const sb = speakerSocket && speakerSocket.account && speakerSocket.account.blocked;
    return !!(vid && sb && sb.has && sb.has(vid));
}

function colorOf(body) {
    const c = body && body.color;
    if (!c) return '';
    if (typeof c === 'string') return c;
    return typeof c.compiled === 'string' ? c.compiled : '';
}

// -> how many clients got the line
function send({ body, socket = null, text, team = false }) {
    if (!body) return 0;
    const t = tidy(text).slice(0, MAX_LEN);
    if (!t) return 0;
    const id = ++seq;
    const name = String(body.name || 'Unnamed').slice(0, 32);
    const col = colorOf(body);
    const myTeam = body.team;
    const plot = socket && socket._tutorialPlot != null ? socket._tutorialPlot : null;
    let n = 0;
    for (const viewer of hooks.clients()) {
        if (!viewer || typeof viewer.talk !== 'function') continue;
        if (viewer.status && viewer.status.disablechat) continue;
        if (team && teamOf(viewer) !== myTeam) continue;
        if (plot != null && viewer._tutorialPlot != null && viewer._tutorialPlot !== plot) continue;
        if (viewer !== socket && blocked(viewer, body, socket)) continue;
        try { viewer.talk('CH', id, body.id | 0, name, col, t, team ? 1 : 0); n++; } catch { /* a closing socket */ }
    }
    return n;
}

// A player's line: spam limits and commands ('chatMessage' listeners, e.g.
// addons/basicChatModeration.js), then the mask, then everyone in the raid.
function fromPlayer(socket, raw, teamFlag) {
    const body = socket && socket.player && socket.player.body;
    if (!body || typeof raw !== 'string') return 0;
    let abort = false, message = raw;
    try {
        if (global.Events) global.Events.emit('chatMessage', {
            gameManager: global.gameManager, message: raw, socket,
            preventDefault: () => { abort = true; },
            setMessage: (str) => { message = str; },
        });
    } catch (e) { console.error('[chat] listener', e && e.message); }
    if (abort) return 0;
    // swears and slurs turn into asterisks for everyone (shared/profanity.js)
    message = profanity.mask(String(message));
    return send({ body, socket, text: message, team: !!teamFlag });
}

module.exports = { send, fromPlayer, tidy, hooks, MAX_LEN };
