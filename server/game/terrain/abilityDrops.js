'use strict';

const ON = process.env.ROYALE_ABILITY_DROPS !== '0';
const ODDS = { crate: 1, epic: 0.75, copper: 0.25 };
const LIFE_MS = 45000;
const TRIAL_MS = 60000;
const ARM_MS = 400;
const OPENER_MS = 1500;
const PICK_R = 24;
const MAX_LIVE = 24;
const FX_RANGE = 2600;

let drops = [];
let seq = 0;
const trials = new Set();

function abilities() { return require('./abilities.js'); }
function enabled() { return ON && abilities().ON && !(global.Config && Config.tutorial); }
function live(b) { return !!b && !b.isGhost && !(b.isDead && b.isDead()); }
function kindOf(chest) { return chest.supplyDrop ? 'crate' : chest.chestRare ? 'epic' : 'copper'; }
function nameOf(id) { const d = abilities().AB_BY_ID.get(id); return d ? d.name : id; }

function pickFor(body, rand = Math.random) {
    const ab = abilities();
    const all = ab.ABILITIES.map(a => a.id);
    let have = [];
    if (body && body.socket) {
        const st = ab.stateOf(body.socket);
        have = st.own.slice();
        const eq = ab.equippedOf(st);
        if (eq) have.push(eq);
    }
    const fresh = all.filter(id => !have.includes(id));
    const pool = fresh.length ? fresh : all;
    return pool[(rand() * pool.length) | 0];
}

function spawn(x, y, id, opts = {}) {
    if (!enabled() || !abilities().AB_BY_ID.has(id)) return null;
    const t = opts.t != null ? opts.t : Date.now();
    seq = (seq + 1) & 0x7fffffff || 1;
    const opener = opts.opener && opts.opener.socket ? opts.opener : null;
    const d = {
        id: seq, ab: id, x: Math.round(x), y: Math.round(y), born: t, until: t + LIFE_MS,
        kind: opts.kind || 'copper', keep: opts.kind === 'crate',
        opener: opener ? opener.id : 0, openerUntil: opener ? t + OPENER_MS : 0,
    };
    drops.push(d);
    while (drops.length > MAX_LIVE) drops.shift();
    return d;
}

function fromChest(chest, opener, rand = Math.random) {
    if (!enabled() || !chest) return null;
    const kind = kindOf(chest);
    if (!(rand() < ODDS[kind])) return null;
    return spawn(chest.x, chest.y, pickFor(opener, rand), { kind, opener });
}

function tell(x, y, kind, b, id) {
    const clients = (global.gameManager && global.gameManager.socketManager && global.gameManager.socketManager.clients) || [];
    for (const c of clients) {
        const cam = c && c.camera;
        if (!cam || Math.abs(cam.x - x) > FX_RANGE || Math.abs(cam.y - y) > FX_RANGE) continue;
        try { c.talk('AF', kind, Math.round(x), Math.round(y), 0, b | 0, id | 0); } catch { }
    }
}

function slotEmpty(st) {
    return !(st.eq && (st.own.includes(st.eq) || st.eq === st.twist)) && !st.twist;
}

function grant(body, d, t = Date.now()) {
    const ab = abilities();
    const socket = body.socket;
    const st = ab.stateOf(socket);
    const id = d.ab, name = nameOf(id);
    const trialOn = !!(st.trial && st.trial.until > t);
    const secs = Math.round(TRIAL_MS / 1000);
    let msg;
    if (slotEmpty(st)) {
        if (!st.own.includes(id)) st.own.push(id);
        st.eq = id;
        st.trial = null;
        trials.delete(socket);
        msg = "You picked up " + name + "! It's in your ability slot now.";
    } else if (ab.equippedOf(st, t) === id && !trialOn) {
        st.cd[id] = 0;
        msg = "You picked up " + name + "! It's ready to use again.";
    } else {
        if (d.keep && !st.own.includes(id)) st.own.push(id);
        st.trial = { id, until: t + TRIAL_MS, drop: true };
        st.cd[id] = 0;
        trials.add(socket);
        msg = "You picked up " + name + "! It's on Q for " + secs + " seconds.";
        if (d.keep) msg += " It's yours to equip at a shop too.";
    }
    ab.talkState(socket, msg);
    return msg;
}

function tickTrials(t) {
    const ab = abilities();
    for (const socket of trials) {
        const st = socket && socket.shop && socket.shop.ab;
        if (!st || !st.trial || !st.trial.drop) { trials.delete(socket); continue; }
        if (st.trial.until > t) continue;
        const body = socket.player && socket.player.body;
        if (st.trial.id === 'burrow' && body && body.burrowUntil > t) continue;
        const name = nameOf(st.trial.id);
        st.trial = null;
        trials.delete(socket);
        const back = ab.equippedOf(st, t);
        ab.talkState(socket, back ? "Your " + name + " ran out, so Q is back to " + nameOf(back) + "." : "Your " + name + " ran out.");
    }
}

function tick(actors, t = Date.now()) {
    if (trials.size) tickTrials(t);
    if (!drops.length) return;
    for (let i = drops.length - 1; i >= 0; i--) {
        const d = drops[i];
        if (t >= d.until) { drops.splice(i, 1); continue; }
        if (t - d.born < ARM_MS) continue;
        for (const a of actors || []) {
            const b = a && a.body ? a.body : a;
            if (!b || !b.socket || b.isBot || !live(b) || b.royaleLobby || b.adminSpec || b.burrowUntil > t) continue;
            if (d.openerUntil > t && b.id !== d.opener) continue;
            const r = PICK_R + (b.realSize || b.size || 30);
            if ((b.x - d.x) ** 2 + (b.y - d.y) ** 2 > r * r) continue;
            drops.splice(i, 1);
            try { grant(b, d, t); } catch { }
            tell(d.x, d.y, 'abget', b.id, d.id);
            break;
        }
    }
}

function snapshot(t = Date.now()) {
    if (!drops.length) return undefined;
    return drops.map(d => ({ i: d.id, k: d.ab, x: d.x, y: d.y, a: t - d.born, l: Math.max(0, d.until - t) }));
}

function reset() { drops = []; }

module.exports = { ON, ODDS, LIFE_MS, TRIAL_MS, ARM_MS, OPENER_MS, PICK_R, enabled, pickFor, spawn, fromChest, grant, tick, snapshot, reset, list: () => drops, _trials: trials };
