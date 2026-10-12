"use strict";
const { unpackMove } = require("../../lib/touchMove.js");

const ON = process.env.PREDICT === "1";
const SEQ_MOD = 1 << 24;
const QMAX = 12;
const DEEP = 4;
const KEEP = 2;

function enabled() { return ON; }

function applyCommand(socket, player, target, reverseTank, commands, moveField, hasMove) {
    if (!socket.player.body.eastereggs.braindamage) player.target = target;
    player.body.reverseTank = reverseTank;
    if (player.command == null) return;
    const c = player.command;
    c.up = commands & 1;
    c.down = (commands & 2) >> 1;
    c.left = (commands & 4) >> 2;
    c.right = (commands & 8) >> 3;
    c.lmb = (commands & 16) >> 4;
    c.mmb = (commands & 32) >> 5;
    c.rmb = (commands & 64) >> 6;
    c.sidearm = (commands & 128) >> 7;
    const analog = hasMove && (commands & 15) ? unpackMove(moveField) : null;
    c.moveX = analog ? analog.x : 0;
    c.moveY = analog ? analog.y : 0;
    c.analog = !!analog;
    if (player.body && (player.body.royaleFrozen || (global.royaleInFall && global.royaleInFall(player.body)))) {
        c.lmb = c.mmb = c.rmb = c.sidearm = 0;
        c.up = c.down = c.left = c.right = 0;
    }
}

function stateOf(socket) {
    let q = socket.predQ;
    if (!q) q = socket.predQ = { list: [], ack: -1, on: false, last: null, depth: 0, starved: false, pops: 0, repeats: 0, drains: 0, drops: 0 };
    return q;
}

function enqueue(socket, target, reverseTank, commands, moveField, word) {
    const q = stateOf(socket);
    const seq = Math.floor(word / 2) % SEQ_MOD;
    if (!q.on) { q.on = true; q.list.length = 0; q.last = null; q.depth = 0; q.starved = false; }
    q.list.push({ seq, tx: target.x, ty: target.y, rev: reverseTank, bits: commands, move: moveField, dash: word % 2 === 1 });
    while (q.list.length > QMAX) {
        const old = q.list.shift();
        if (old.dash) q.list[0].dash = true;
        q.drops++;
    }
}

function legacy(socket) {
    const q = socket.predQ;
    if (!q || !q.on) return;
    q.on = false;
    q.list.length = 0;
    q.ack = -1;
}

let abil = null;
function dashNow(socket, body) {
    try {
        abil = abil || require("../terrain/abilities.js");
        if (!abil.ON || !body) return;
        if (global.royaleInFall && global.royaleInFall(body)) return;
        require("./activity.js").noteAction(socket);
        abil.dash(body, 0, 0);
    } catch (e) { }
}

function tick(clients, Config) {
    if (!ON || !clients) return;
    for (let i = 0; i < clients.length; i++) {
        const socket = clients[i];
        const q = socket.predQ;
        if (!q || !q.on) continue;
        const player = socket.player;
        if (!player || !player.body || !player.command) { q.list.length = 0; continue; }
        let e = q.list.shift();
        if (!e) { q.repeats++; q.starved = true; q.depth = 0; continue; }
        const last = q.last;
        if (q.list.length >= 2 && last && !e.dash && e.bits === last.bits && (e.bits & 15) === 0 && e.move === last.move) {
            const v = player.body.velocity;
            if (!v || Math.abs(v.x) + Math.abs(v.y) < 0.02) {
                e = q.list.shift();
                q.drains++;
            }
        }
        if (q.list.length >= DEEP) {
            while (q.list.length > KEEP) {
                const n = q.list.shift();
                if (e.dash) n.dash = true;
                e = n;
                q.drops++;
            }
        }
        q.pops++;
        q.last = e;
        q.depth = q.list.length;
        applyCommand(socket, player, { x: e.tx, y: e.ty }, e.rev, e.bits, e.move, true);
        q.ack = e.seq;
        if (e.dash && (Config.dig_royale || Config.tutorial)) dashNow(socket, player.body);
    }
}

function forced(body) {
    if (!body) return true;
    const m = body._abMove;
    if (m && m.kind !== "dash") return true;
    if (body.royaleFrozen || body.bond || body.motionType !== "motor" || body._tutorialGlide || body.arenaBounds) return true;
    if (body.godmode || body.noclip || body.isArenaCloser) return true;
    if (global.royaleInFall && global.royaleInFall(body)) return true;
    if ((body.burrowUntil || 0) > Date.now()) return true;
    return false;
}

function ackWord(socket, body, scoping) {
    const q = socket.predQ;
    if (!q || !q.on || q.ack < 0) return scoping;
    const dashing = !!(body && body._abMove && body._abMove.kind === "dash");
    const starved = q.starved ? 1 : 0;
    q.starved = false;
    return (q.ack + 1) * 64 + starved * 32 + Math.min(3, q.depth | 0) * 8 + (dashing ? 4 : 0) + (forced(body) ? 2 : 0) + (scoping ? 1 : 0);
}

function advert(socket, Config) {
    if (!ON) return;
    const gm = global.gameManager;
    let dash = null;
    try { dash = require("../terrain/abilities.js").DASH; } catch (e) { dash = null; }
    const W = gm && gm.room ? gm.room.width : 0, H = gm && gm.room ? gm.room.height : 0;
    const rect = Config.arena_shape !== "circle" && W > 0 && H > 0;
    socket.talk("PZ", 1, gm.roomSpeed || 1, rect ? W : 0, rect ? H : 0, rect ? Config.room_bound_force : 0,
        dash ? dash.mult : 0, dash ? dash.minSpeed : 0, dash ? dash.ms : 0);
}

module.exports = { enabled, enqueue, legacy, tick, ackWord, advert, applyCommand, forced, SEQ_MOD };
