// Sidekicks: a tiny tank that tags along with a logged-in player who has one
// equipped in the Locker (accounts/store.js sidekickFor, put on the body at
// spawn as body.sidekick by accounts/game/bridge.js applyIdentity).
//
// There is no entity. The server keeps a small table of who has one (owner
// entity id, which sidekick, skin, name style, colour, name) and whether the
// owner is hidden right now, and sends it as 'SK' packets: the whole table
// once per socket, then only what changed. Every client draws the sidekick
// beside its owner's tank and moves it and fires its shots locally
// (public/client/sidekicks.js). So nothing on the server can hit, push,
// target or count it (bots, turrets, drones, radar, bounty, hunted, kill
// credit, the board, gems, rock, bosses, the Core), its shots do nothing
// because they never exist here, and a full raid of them costs a few
// hundred bytes when someone spawns or dies instead of an entity in every
// view packet.
//
// Hidden: smoke, burrow, the sky drop's fall, the raid-end freeze and a
// faded or invisible tank. The client also only draws a sidekick where it
// draws the owner's tank, so a sidekick never shows where its owner isn't.
// Death, leaving and the raid end drop the row; the next spawn adds it back.
//
// SK packet, one JSON string:
//   {f: [row...]}                 the whole table (first packet a socket gets)
//   {a: [row...], d: [id...], h: [[id, 0|1]...]}   added, gone, hidden flips
//   row = [ownerId, sidekickNid, skinNid, nameStyleNid, colour ('' = own), name, hidden 0|1]
//
// ROYALE_SIDEKICKS=0 turns them off.
'use strict';

const ON = process.env.ROYALE_SIDEKICKS !== '0';
const EVERY_MS = 100;
const SHOWN_ALPHA = 0.9;     // a tank faded below this (invisibility) hides its sidekick

let hooks = {};
const table = new Map();     // owner body id -> { body, kick, hidden }
let adds = [], dels = [], flips = [];
let lastAt = 0;

// dig_royale.js: clients() (connected sockets)
function attach(h) { hooks = h || {}; }
function enabled() { return ON && !!Config.dig_royale && !Config.tutorial; }

const alive = (b) => !!b && !b.isGhost && !(b.isDead && b.isDead());

function hiddenNow(b, t) {
    return !!(b.smokeHidden || b.royaleFrozen || (b.burrowUntil || 0) > t || (b._dropHoldUntil || 0) > t ||
        (b.alpha != null && b.alpha < SHOWN_ALPHA));
}

function rowOf(id, e) {
    const k = e.kick;
    return [id, k.nid | 0, k.skin | 0, k.ns | 0, k.color || '', String(k.name || ''), e.hidden ? 1 : 0];
}

function send(client, json) {
    try { client.talk('SK', json); } catch (e) { /* socket closing */ }
}

// Every connected socket gets the whole table once, then the changes.
function flush(clients) {
    const changed = adds.length || dels.length || flips.length;
    let full = null, diff = null;
    for (const c of clients || []) {
        // not before the handshake: the client clears its table on 'w'
        if (!c || c.terminated || (c.status && !c.status.verified)) continue;
        if (!c._skFull) {
            c._skFull = true;
            if (table.size) send(c, full || (full = JSON.stringify({ f: [...table].map(([id, e]) => rowOf(id, e)) })));
            continue;
        }
        if (changed) send(c, diff || (diff = JSON.stringify({ a: adds, d: dels, h: flips })));
    }
    adds = []; dels = []; flips = [];
}

// bodies: the live players this tick (humans only have sidekicks)
function tick(t, bodies, clients) {
    if (!enabled()) return;
    if (t - lastAt < EVERY_MS) return;
    lastAt = t;
    for (const b of bodies || []) {
        if (!b || !b.sidekick || !b.socket || table.has(b.id) || !alive(b)) continue;
        const e = { body: b, kick: b.sidekick, hidden: hiddenNow(b, t) };
        table.set(b.id, e);
        adds.push(rowOf(b.id, e));
    }
    for (const [id, e] of table) {
        const b = e.body;
        if (!alive(b) || !b.socket || b.socket.terminated || b.sidekick !== e.kick) {
            table.delete(id);
            dels.push(id);
            continue;
        }
        const h = hiddenNow(b, t);
        if (h !== e.hidden) { e.hidden = h; flips.push([id, h ? 1 : 0]); }
    }
    flush(clients || (hooks.clients ? hooks.clients() : []));
}

// Drop a body's row now (death, leaving), not at the next tick.
function drop(body) {
    if (!body || !table.has(body.id)) return;
    table.delete(body.id);
    dels.push(body.id);
}

function reset() {
    for (const id of table.keys()) dels.push(id);
    table.clear();
}

// tests / DBG: what the clients are being told
function snapshot() { return [...table].map(([id, e]) => rowOf(id, e)); }

module.exports = { ON, EVERY_MS, attach, enabled, tick, drop, reset, snapshot, hiddenNow };
