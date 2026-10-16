function aoWorld() { try { return require('./alwaysOn.js').on(); } catch { return false; } }
// Save codes, game side: "Save & leave" and "$restore CODE".
//
// Saving: the 'SV' packet starts a HOLD_MS hold. The tank has to stay put
// the whole time: no movement or fire keys (autofire and the sidearm
// included), no kit use, no damage taken and not in the storm. Anything else
// cancels it with the reason. At the end the tank is written to the saves
// table (accounts/saves.js), the player gets the code (SVS 'done') and the
// tank leaves the world the way a normal leave does: the ranked life settles
// as a disconnect, the bank goes back to the persistent store, and nothing
// drops (the satchel is in the code). So a save can never be played on and
// restored at the same time.
//
// Restoring: "$restore CODE" in chat while alive in a raid of the same mode.
// The code is used up in one transaction; the tank takes the saved class and
// build (within this life's own skill points), the kit, gear and sidearm (the
// shop's own limits), the satchel (up to the satchel cap), the growth (saved
// on top of what this life has, not cut to the respawn quarter) and the raid
// points. None of that counts for rank or placement: the points go into the
// stat's rankDiscount and restoredPts, and gems the restored satchel banks
// later count the same way (dig_royale onBanked). Only what is earned after
// the restore counts.
//
// Packets:
//   <- SV  1 start, 0 cancel
//   -> SVS JSON {st:'on', ms, left} | {st:'off', why} | {st:'done', code, exp, mode}
'use strict';

const crypto = require('crypto');

const HOLD_MS = (process.env.ROYALE_DEBUG && parseInt(process.env.ROYALE_SAVE_HOLD_MS, 10) > 0)
    ? parseInt(process.env.ROYALE_SAVE_HOLD_MS, 10) : 20 * 1000;
const PROGRESS_MS = 1000;
const TRY_WINDOW_MS = 10 * 60 * 1000;
const TRY_MAX = 6;
const SAVE_GAP_MS = 1000;       // start presses closer than this are ignored
// this thread's raids (a save restored in the same raid removes its old row)
const THREAD_TAG = crypto.randomBytes(6).toString('hex');

// dig_royale attaches: {stat(body), statKey(body), scoreOf(s), raidId(),
// ending(), growthScore(body), growRoom(body), leave(socket, body), dropRow(key)}
let ctx = null;
function attach(c) { ctx = c; }

let savesMod = null;
function saves() { return savesMod || (savesMod = require('../../accounts/saves.js')); }
let bridgeMod = null;
function bridge() { return bridgeMod || (bridgeMod = require('../../accounts/game/bridge.js')); }
function shop() { return require('./shop.js'); }
function gems() { return require('./gems.js'); }
function dust() { return require('../../accounts/game/dustHooks.js'); }

function mode() { return Config.royale_duos ? 'duo' : 'solo'; }
function modeName(m) { return m === 'duo' ? 'Duos' : 'Solo'; }

function on() {
    try { return !!(Config.dig_royale && !Config.tutorial && bridge().active()); } catch (e) { return false; }
}

function send(socket, obj) {
    try { socket.talk('SVS', JSON.stringify(obj)); } catch (e) { /* closing */ }
}
function say(socket, text, ms = 6000) {
    try { socket.talk('m', ms, text); } catch (e) { /* closing */ }
}

function bodyOf(socket) {
    const b = socket && socket.player && socket.player.body;
    return b && b.socket === socket && !(b.isDead && b.isDead()) && b.royaleAlive !== false ? b : null;
}

function logErr(what, e) {
    const t = Date.now();
    if (t - (logErr.at || 0) < 10000) return;
    logErr.at = t;
    console.error('[saves] ' + what + ' failed: ' + ((e && e.stack) || e));
}

// ── the hold ─────────────────────────────────────────────────────────────

function heldInput(socket) {
    const c = socket.player && socket.player.command;
    if (!c) return null;
    if (c.up || c.down || c.left || c.right) return "You moved";
    if (c.lmb || c.rmb || c.mmb || c.sidearm || c.autofire) return "You fired";
    return null;
}

function inStorm(body) {
    try { return !!require('./storm.js').inStorm(body.x, body.y); } catch (e) { return false; }
}

function hpOf(body) {
    return ((body.health && body.health.amount) || 0) + ((body.shield && body.shield.amount) || 0);
}

// 'SV' 1: start, 0: cancel
function onPacket(socket, want) {
    if (!want) return cancel(socket, "Save cancelled.");
    if (socket._saving) return cancel(socket, "Save cancelled.");
    return start(socket);
}

function start(socket) {
    if (!Config.dig_royale || Config.tutorial) return false;
    const refuse = (why) => { send(socket, { st: 'off', why }); return false; };
    if (!on()) return refuse("Saving isn't available on this server right now.");
    const body = bodyOf(socket);
    if (!body) return refuse(aoWorld() ? "You can only save while you're alive in the game." : "You can only save while you're alive in a raid.");
    if (ctx && ctx.ending()) return refuse("The raid is over, so you'll have to save next raid.");
    const t = Date.now();
    if (t - (socket._lastSaveTry || 0) < SAVE_GAP_MS) return refuse("Please wait a second and try again.");
    const held = heldInput(socket);
    if (held) return refuse("Stop moving and shooting first, then save.");
    if (inStorm(body)) return refuse("Get out of the storm first.");
    socket._lastSaveTry = t;
    socket._saving = { at: t, hp: hpOf(body), hitAt: body.hitAt || 0, lastSent: t };
    send(socket, { st: 'on', ms: HOLD_MS, left: HOLD_MS });
    return true;
}

function cancel(socket, why) {
    if (!socket || !socket._saving) return false;
    socket._saving = null;
    send(socket, { st: 'off', why: why || "Save cancelled." });
    return true;
}

// Kit use and the like (sockets.js) end a hold too.
function interrupt(socket, why) {
    if (socket && socket._saving) cancel(socket, why);
}

function tick(t, clients) {
    for (const socket of clients) {
        const sv = socket && socket._saving;
        if (!sv) continue;
        const body = bodyOf(socket);
        let why = null;
        if (!body) why = "You died, so nothing was saved.";
        else if (ctx && ctx.ending()) why = "The raid ended before the save finished.";
        else if (heldInput(socket)) why = heldInput(socket) + ", so the save stopped. Stay still for " + Math.round(HOLD_MS / 1000) + " seconds.";
        else if ((body.hitAt || 0) > sv.hitAt || hpOf(body) < sv.hp - 0.5) why = "You took damage, so the save stopped.";
        else if (inStorm(body)) why = "The storm reached you, so the save stopped.";
        if (why) { cancel(socket, why); continue; }
        const left = sv.at + HOLD_MS - t;
        if (left <= 0) { finish(socket, body, t); continue; }
        if (t - sv.lastSent >= PROGRESS_MS) {
            sv.lastSent = t;
            send(socket, { st: 'on', ms: HOLD_MS, left });
        }
    }
}

// ── the record ───────────────────────────────────────────────────────────

let classKeys = null;
function classKeyOf(def) {
    if (typeof def === 'string') return def in Class ? def : null;
    if (!classKeys) {
        classKeys = new Map();
        for (const k of Object.keys(Class)) { try { classKeys.set(Class[k], k); } catch (e) { /* */ } }
    }
    return classKeys.get(def) || null;
}

function shopRecord(socket, t) {
    const st = shop().stateOf(socket);
    if (!st) return null;
    const gear = {};
    // timed gear keeps its time left; permanent gear is a twist's or the
    // tutorial's, and stays with that raid
    for (const [id, until] of Object.entries(st.gear || {})) {
        if (until !== true && until > t) gear[id] = Math.round(until - t);
    }
    const twistArm = st._twistArm && st._twistArm === st.arm;
    // under a twist the paid sidearm is set aside, not gone: save that one
    const arm = twistArm ? (st._paidArm && st._paidArm.id) || null : st.arm || null;
    const armUntil = twistArm ? (st._paidArm && st._paidArm.until) || 0 : st.armUntil || 0;
    return {
        drill: st.drill | 0,
        gear,
        kit: Object.assign({}, st.kit || {}),
        kitOrder: (st.kitOrder || []).slice(),
        arm,
        armLeft: arm && armUntil ? Math.max(0, Math.round(armUntil - t)) : 0,
        // owned abilities (a trial or a twist's stays with that raid)
        ab: st.ab ? { own: (st.ab.own || []).slice(), eq: st.ab.own && st.ab.own.includes(st.ab.eq) ? st.ab.eq : null } : undefined,
    };
}

function buildRecord(socket, body, t) {
    const s = ctx.stat(body);
    const score = s ? ctx.scoreOf(s) : 0;
    const carried = Math.max(0, body.carriedGems | 0);
    const defs = [];
    for (const d of body.defs || []) {
        const k = classKeyOf(d);
        if (!k) { defs.length = 0; break; }
        defs.push(k);
    }
    return {
        v: 1, mode: mode(), savedAt: t, name: String(body.name || ''),
        label: String(body.label || ''), defs,
        skillRaw: body.skill ? body.skill.raw.slice() : null,
        points: body.skill ? body.skill.points | 0 : 0,
        level: body.skill ? body.skill.level | 0 : 0,
        growEff: Math.max(0, Math.round(body._growEff || 0)),
        growth: +(body.growthMult || 1).toFixed(3),
        score,
        // the raid points (the satchel was never points: it comes back as gems)
        pts: Math.max(0, score),
        carried,
        banked: Math.max(0, (socket.gemBanked || 0) | 0),
        kept: Math.max(0, socket.bankKept | 0),
        shop: shopRecord(socket, t),
        raid: { tag: THREAD_TAG, id: ctx.raidId(), key: ctx.statKey(body) },
    };
}

function finish(socket, body, t) {
    socket._saving = null;
    let rec = null, made = null;
    try { rec = buildRecord(socket, body, t); } catch (e) { logErr('record', e); }
    // the satchel's gemdust rides along for the same account
    let dustCarried = 0;
    if (rec) {
        try { dustCarried = dust().carriedOf(body) | 0; } catch (e) { dustCarried = 0; }
        rec.dustCarried = socket.account ? dustCarried : 0;
        try {
            made = saves().create({
                mode: rec.mode, userId: socket.account ? socket.account.id : 0, guestId: socket.guestId || null,
                data: rec, score: rec.score, ip: socket.ip || null,
            }, t);
        } catch (e) { logErr('create', e); made = null; }
    }
    if (!made) {
        send(socket, { st: 'off', why: aoWorld() ? "Saving failed on our end. You're still in the game." : "Saving failed on our end. You're still in the raid." });
        return false;
    }
    console.log('[RAID] ' + (body.name || 'A player') + ' saved and left (' + rec.label + ', ' + rec.score + ' pts).');
    send(socket, { st: 'done', code: made.code, exp: made.expiresAt, mode: rec.mode });
    // nothing drops and nothing is lost: it's all in the code now
    body.carriedGems = 0;
    if (socket) { socket.gemBanked = 0; socket.bankKept = 0; }
    body.bankedGems = 0;
    body._savedOut = true;
    body.deathCause = 'saved';
    try { dust().stash(body); } catch (e) { /* */ }
    socket.leftOnPurpose = true;
    socket._savedOut = true;
    try { ctx.leave(socket, body); } catch (e) { logErr('leave', e); }
    return true;
}

// ── restore ──────────────────────────────────────────────────────────────

function fmt(n) { return (n | 0).toLocaleString('en-US'); }

function tryAllowed(socket, t) {
    const list = (socket._restoreTries || []).filter(x => t - x < TRY_WINDOW_MS);
    socket._restoreTries = list;
    if (list.length >= TRY_MAX) return false;
    list.push(t);
    return true;
}

// "$restore CODE" -> true when the line was a restore (never shown as chat)
function chat(socket, raw) {
    const m = /^\$restore(?:\s+(.*))?$/i.exec(String(raw || '').trim());
    if (!m) return false;
    if (!Config.dig_royale || Config.tutorial) { say(socket, "Save codes work in raids."); return true; }
    const code = String(m[1] || '').trim();
    if (!code) { say(socket, "Type $restore and then your save code."); return true; }
    restore(socket, code);
    return true;
}

function restore(socket, code, t = Date.now()) {
    if (!on()) { say(socket, "Restoring isn't available on this server right now."); return { ok: false, reason: 'off' }; }
    const body = bodyOf(socket);
    if (!body || body.royaleLobby || body.royaleFrozen) { say(socket, aoWorld() ? "You can restore a save while you're alive in the game." : "You can restore a save while you're alive in a raid."); return { ok: false, reason: 'dead' }; }
    if (ctx && ctx.ending()) { say(socket, "The raid is over, so restore it next raid."); return { ok: false, reason: 'ending' }; }
    if (socket._saving) cancel(socket, "Save cancelled.");
    if (!saves().normalize(code)) { say(socket, "That doesn't look like a save code. It's 25 letters and numbers."); return { ok: false, reason: 'format' }; }
    if (!tryAllowed(socket, t)) { say(socket, "You've tried too many times. Please wait a few minutes."); return { ok: false, reason: 'tries' }; }
    let res = null;
    try {
        res = saves().restore({
            code, mode: mode(), userId: socket.account ? socket.account.id : 0, guestId: socket.guestId || null, ip: socket.ip || null,
        }, t);
    } catch (e) { logErr('restore', e); res = { ok: false, reason: 'error' }; }
    if (!res.ok) {
        const why = {
            format: "That doesn't look like a save code.",
            unknown: "There's no save with that code. Check it and try again.",
            used: "That code was already used. Each one works once.",
            expired: "That code ran out, since codes only last 7 days.",
            mode: "That's a " + modeName(res.mode) + " save. Restore it in " + modeName(res.mode) + ".",
            wait: "You restored a save not long ago. Try again in " + Math.ceil((res.waitMs || 0) / 60000) + " min.",
        }[res.reason] || "That save couldn't be restored right now.";
        say(socket, why);
        return res;
    }
    // it may have died between the check and here (it can't: this is all one tick)
    const out = apply(socket, body, res.data || {}, t, res.savedBy);
    carryGuestLevels(socket, res.savedBy);
    return Object.assign({ ok: true }, out);
}

function carryGuestLevels(socket, savedBy) {
    const g = savedBy && savedBy.guestId;
    if (!socket.account || !g || g === socket.guestId) return null;
    let lv = null;
    try { lv = require('../../accounts/game/levelHooks').adoptGuest(socket, g, socket.account.id); } catch (e) { logErr('levels', e); return null; }
    if (lv && lv.moved) say(socket, 'The levels from that guest save came with you. You are Level ' + lv.level + ' now.');
    return lv;
}

function applyClass(body, data) {
    if (!Array.isArray(data.defs) || !data.defs.length || data.defs.length > 8) return false;
    const defs = [];
    for (const k of data.defs) {
        if (typeof k !== 'string' || !(k in Class)) return false;
        defs.push(k);
    }
    try {
        body.upgrades = [];
        body.define(defs.length === 1 ? defs[0] : defs);
        return true;
    } catch (e) { logErr('class', e); return false; }
}

// Within this life's own points: the saved build if it fits, else a clean one.
function applySkills(body, data) {
    const sk = body.skill;
    if (!sk || !Array.isArray(data.skillRaw)) return;
    const total = sk.raw.reduce((a, b) => a + (b | 0), 0) + (sk.points | 0);
    const caps = sk.caps || [];
    const raw = sk.raw.map((_, i) => Math.max(0, Math.min((caps[i] != null ? caps[i] : 9) | 0, (data.skillRaw[i] | 0))));
    const used = raw.reduce((a, b) => a + b, 0);
    if (used > total) return;
    sk.set(raw);
    sk.points = total - used;
}

function applyShop(socket, body, rec, t) {
    if (!rec) return;
    const sh = shop();
    const st = sh.stateOf(socket);
    if (!st) return;
    st.drill = Math.max(st.drill | 0, Math.max(0, Math.min(5, rec.drill | 0)));
    const running = () => Object.keys(st.gear).filter(id => sh.gearActive(st, id)).length;
    // Items the shop no longer sells come back as banked gems: gear for the
    // time it had left, kit items at full price.
    let refund = 0;
    const offered = (item) => !sh.offered || sh.offered(item);
    for (const [id, left] of Object.entries(rec.gear || {})) {
        const item = sh.BY_ID.get(id);
        if (!item || item.cat !== 'gear' || !(left > 0)) continue;
        if (!offered(item)) { refund += Math.round(item.price * Math.min(1, left / (5 * 60 * 1000))); continue; }
        const until = t + Math.min(left, 5 * 60 * 1000);
        if (sh.gearActive(st, id)) { if (st.gear[id] !== true && st.gear[id] < until) st.gear[id] = until; continue; }
        if (running() >= (sh.GEAR_MAX || 4)) continue;
        st.gear[id] = until;
    }
    const recOrder = rec.kitOrder || [];
    for (let slot = 0; slot < recOrder.length; slot++) {
        const id = recOrder[slot];
        if (!id) continue;      // an empty slot the player left between items
        const n = rec.kit && rec.kit[id] | 0;
        const item = sh.BY_ID.get(id);
        if (!item || item.cat !== 'kit' || n <= 0) continue;
        if (!offered(item)) { refund += item.price * Math.min(item.max || 1, n); continue; }
        const have = st.kit[id] | 0;
        if (!have && sh.kitCount(st.kitOrder) >= sh.KIT_SLOTS) continue;
        st.kit[id] = Math.min(item.max || 1, have + n);
        // back in the slot it was saved in when that one is free
        if (!st.kitOrder.includes(id)) {
            while (st.kitOrder.length <= slot) st.kitOrder.push(null);
            if (!st.kitOrder[slot]) st.kitOrder[slot] = id;
            else st.kitOrder[sh.kitFreeSlot(st.kitOrder)] = id;
        }
    }
    if (rec.arm && !st.arm) {
        const ok = sh.grantArm(socket, rec.arm, true, body);
        if (ok && rec.arm === 'pod') st.armUntil = t + Math.max(1000, rec.armLeft | 0);
    }
    if (rec.ab && Array.isArray(rec.ab.own)) {
        try {
            const ab = require('./abilities.js');
            if (ab.ON) {
                const ast = ab.stateOf(socket);
                for (const id of rec.ab.own) if (ab.AB_BY_ID.has(id) && !ast.own.includes(id)) ast.own.push(id);
                // the saved slot only fills an empty one: what you hold now stays
                const held = ast.eq && (ast.own.includes(ast.eq) || ast.eq === ast.twist);
                if (rec.ab.eq && ast.own.includes(rec.ab.eq) && !held) ast.eq = rec.ab.eq;
                // the save brought its own ability: no first-bank trial on top
                if (ast.own.length) { ast.trialUsed = true; ast.trial = null; }
                ab.talkState(socket);
            } else {
                // switched off: what they paid comes back
                for (const id of rec.ab.own) { const it = sh.BY_ID.get(id); if (it) refund += it.price; }
            }
        } catch (e) { logErr('abilities', e); }
    }
    if (refund > 0) {
        try {
            gems().setBanked(body, ((socket.gemBanked || 0) | 0) + refund);
            say(socket, "Items the shop doesn't sell any more came back as " + fmt(refund) + " banked gems.", 7000);
        } catch (e) { /* */ }
    }
    try { sh.applyPassives(body); } catch (e) { /* */ }
}

function apply(socket, body, data, t, savedBy) {
    const s = ctx.stat(body);
    // the saver's old row in this same raid goes (it would count twice)
    if (data.raid && data.raid.tag === THREAD_TAG && data.raid.id === ctx.raidId() && data.raid.key && data.raid.key !== ctx.statKey(body)) {
        try { ctx.dropRow(data.raid.key); } catch (e) { /* */ }
    }
    const classOk = applyClass(body, data);
    applySkills(body, data);
    try { body.refreshBodyAttributes(); if (body.syncSkillsToGuns) body.syncSkillsToGuns(); } catch (e) { /* */ }
    applyShop(socket, body, data.shop, t);
    // banked shop gems from the save code come back with the build
    const savedBanked = Math.max(0, Math.min(50000, data.banked | 0));
    const savedKept = Math.max(0, Math.min(savedBanked, data.kept | 0));
    if (savedBanked > 0) {
        try {
            socket.bankKept = Math.max(socket.bankKept | 0, savedKept);
            gems().setBanked(body, ((socket.gemBanked || 0) | 0) + savedBanked);
        } catch (e) { /* */ }
    }
    // the satchel, up to what it holds now
    let cap = body.gemCap | 0;
    try { cap = shop().satchelCap(body) | 0; } catch (e) { /* */ }
    const room = Math.max(0, cap - (body.carriedGems | 0));
    const carried = Math.min(room, Math.max(0, data.carried | 0));
    if (carried > 0) {
        body.carriedGems = (body.carriedGems | 0) + carried;
        if (s) s.restoredCarry = (s.restoredCarry | 0) + carried;
    }
    // same account: the satchel's gemdust comes back with it
    if (data.dustCarried > 0 && socket.account && savedBy && savedBy.userId === socket.account.id) {
        try { dust().restore(body, (dust().carriedOf(body) | 0) + (data.dustCarried | 0)); } catch (e) { /* */ }
    }
    try { gems().updateSatchel(body); gems().talkGems(body, carried); } catch (e) { /* */ }
    // the raid points: on the board, never for rank or placement
    const pts = Math.max(0, Math.min(10000000, data.pts | 0));
    if (s && pts > 0) {
        s.extra = (s.extra | 0) + pts;
        s.restoredPts = (s.restoredPts | 0) + pts;
        s.rankDiscount = (s.rankDiscount || 0) + pts;
    }
    if (s) { s.restored = (s.restored | 0) + 1; s.restoredAt = t; }
    // the stat reads the satchel off the body: bring it up to date first, or
    // the restored satchel's half would count for growth a second time
    try { ctx.stat(body); } catch (e) { /* */ }
    // growth: the saved growth on top of this life's, not cut to a quarter.
    // After the points, so the new score is the baseline it grows on from.
    const growEff = Math.max(0, data.growEff | 0);
    if (growEff > 0) {
        try {
            require('./growth.js').onSpawn(body, ctx.growthScore(body), Math.max(1, (body._growEff || 0) + growEff));
            ctx.growRoom(body);
        } catch (e) { logErr('growth', e); }
    }
    try { shop().talkState(socket); } catch (e) { /* */ }
    const parts = [];
    if (classOk && data.label) parts.push(data.label);
    if (pts) parts.push(fmt(pts) + " points");
    if (savedBanked) parts.push(fmt(savedBanked) + " banked gems");
    if (carried) parts.push(fmt(carried) + " gems in your satchel");
    say(socket, "Save restored" + (parts.length ? ": " + parts.join(", ") : "") + ". Only what you earn from here counts for rank.", 9000);
    if (carried < (data.carried | 0)) say(socket, "Your satchel was too full for " + fmt((data.carried | 0) - carried) + " of the saved gems.", 7000);
    try { socket.talk('KC', 'restored', 'Save restored', 0, pts ? fmt(pts) + " points back" : ""); } catch (e) { /* */ }
    console.log('[RAID] ' + (body.name || 'A player') + ' restored a save (' + (data.label || '?') + ', ' + pts + ' pts).');
    return { pts, carried, banked: savedBanked, classOk, growEff };
}

module.exports = { HOLD_MS, THREAD_TAG, attach, onPacket, start, cancel, interrupt, tick, chat, restore, buildRecord, applyShop, shopRecord };
