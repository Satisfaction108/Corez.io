'use strict';

const L = require('../../../shared/levels.js');

const SAVE_MS = 5000;
const TICK_MS = 1000;
const ACTIVE_MS = 20000;
const IDLE_MS = 60000;
const KILL_MIN_ALIVE_MS = 5000;
const REPEAT_MS = 10 * 60 * 1000;
const REPEAT_MAX = 2;

let bridgeMod = null, storeMod = null, actMod = null;
function bridge() { return bridgeMod || (bridgeMod = require('./bridge')); }
function store() { return storeMod || (storeMod = require('../levels')); }
function activity() { return actMod || (actMod = require('../../game/network/activity.js')); }

let forced = null;
const OFF = process.env.LEVELS === 'off';
function on() {
    if (forced != null) return forced;
    if (OFF) return false;
    try { return bridge().rankedOn(); } catch (e) { return false; }
}

let errAt = 0;
function logErr(what, e) {
    const t = Date.now();
    if (t - errAt < 10000) return;
    errAt = t;
    console.error('[levels] ' + what + ' failed: ' + ((e && e.stack) || e));
}

const live = new Set();
let lastTickAt = 0, lastSaveAt = 0, shutdownHooked = false;

function ownerOf(socket) {
    if (socket.account && socket.account.id) return { kind: 'a', id: socket.account.id };
    if (typeof socket.guestId === 'string' && /^[a-f0-9]{32}$/.test(socket.guestId)) return { kind: 'g', id: socket.guestId };
    return null;
}
const keyOf = (o) => o.kind + ':' + o.id;

function clients() {
    const m = global.gameManager && global.gameManager.socketManager;
    return (m && m.clients) || [];
}

function idleMs(socket, t) {
    try { return activity().inputIdleMs(socket, t); } catch (e) { return 0; }
}

function send(socket, st, res, extra) {
    const v = st && st.view;
    if (!socket || socket.terminated || !v || !v.on) return;
    const o = {
        lv: v.level, xp: v.xp, into: v.into, need: v.need, max: v.max ? 1 : 0, title: v.title,
        life: st.life | 0, day: v.dayXp | 0, cap: v.dayCap | 0, next: v.nextLine || '', guest: st.owner.kind === 'g' ? 1 : 0,
    };
    if (res && res.ups && res.ups.length) o.ups = res.ups.slice(-3).map(u => ({ lv: u.level, line: u.line, text: u.text, ms: u.milestone ? 1 : 0 }));
    if (res && res.capped) o.capped = 1;
    if (extra) Object.assign(o, extra);
    try { socket.talk('LV', JSON.stringify(o)); } catch (e) { void e; }
}

function stateOf(socket) {
    if (!socket || socket.terminated || !on()) return null;
    const owner = ownerOf(socket);
    if (!owner) return null;
    const key = keyOf(owner);
    let st = socket._lv;
    if (st && st.key === key) return st;
    if (st) flush(socket, st);
    st = { owner, key, milli: 0, life: 0, view: null, victims: new Map() };
    try { st.view = store().status(owner, Date.now()); } catch (e) { logErr('load', e); st.view = null; }
    socket._lv = st;
    live.add(socket);
    if (!shutdownHooked) {
        shutdownHooked = true;
        try { require('../index').onShutdown(() => saveAll()); } catch (e) { void e; }
    }
    send(socket, st, null);
    return st;
}

function apply(socket, st, res, now) {
    st.life += res.gained | 0;
    try { st.view = store().viewOf(st.owner, { xp: res.xp, level: res.level, day: res.day, dayXp: res.dayXp }, now); } catch (e) { logErr('view', e); }
    const capNew = res.capped && st.capDay !== res.day;
    if (capNew) st.capDay = res.day;
    if (res.gained > 0 || (res.ups && res.ups.length) || capNew) send(socket, st, capNew ? res : Object.assign({}, res, { capped: false }));
    if (st.owner.kind === 'a' && res.dustMilli > 0) {
        try {
            require('./dustHooks').noteExternalCredit(st.owner.id, res.dustMilli, res.balanceMilli);
            bridge().du(socket, res.dustMilli, 7, true);
        } catch (e) { void e; }
    }
}

function flush(socket, st, now = Date.now(), reason = 'play') {
    if (!st) return null;
    const whole = Math.floor(st.milli / 1000);
    if (whole <= 0) return null;
    if (st.capDay === L.dayOf(now)) { st.milli = 0; return null; }
    st.milli -= whole * 1000;
    let res = null;
    try { res = store().addXp(st.owner, whole, reason, now); } catch (e) {
        st.milli += whole * 1000;
        logErr('flush', e);
        return null;
    }
    if (!res) return null;
    apply(socket, st, res, now);
    return res;
}

function add(socket, milli) {
    if (!(milli > 0)) return null;
    const st = stateOf(socket);
    if (!st) return null;
    st.milli += milli;
    return st;
}

function onBank(body, amount) {
    const s = body && body.socket;
    if (!s || !(amount > 0) || idleMs(s, Date.now()) > IDLE_MS) return;
    add(s, Math.floor(amount) * 1000 / L.XP.gemsPerXp);
}

function victimKey(v) {
    const s = v && v.socket;
    if (!s) return null;
    if (s.account && s.account.id) return 'a:' + s.account.id;
    return s.guestId ? 'g:' + s.guestId : 's:' + s.id;
}

function repeatOk(st, victim, t) {
    const k = victimKey(victim);
    if (!k) return true;
    const list = (st.victims.get(k) || []).filter(x => t - x < REPEAT_MS);
    if (list.length >= REPEAT_MAX) { st.victims.set(k, list); return false; }
    list.push(t);
    st.victims.set(k, list);
    if (st.victims.size > 64) st.victims.delete(st.victims.keys().next().value);
    return true;
}

function onDeath(victim, i) {
    const t = Date.now();
    const info = i || {};
    const killer = info.killer;
    if (killer && killer !== victim && killer.socket && !info.raidEnd && idleMs(killer.socket, t) <= IDLE_MS) {
        const s = killer.socket;
        if (info.victimBot) add(s, L.XP.botKill * 1000);
        else if (!victim.royaleBornAt || t - victim.royaleBornAt >= KILL_MIN_ALIVE_MS) {
            const st = stateOf(s);
            if (st && repeatOk(st, victim, t)) st.milli += L.XP.kill * 1000;
        }
    }
    if (!victim || !victim.socket || info.cause === 'despawn') return;
    const s = victim.socket;
    const st = stateOf(s);
    if (!st) return;
    flush(s, st, t, 'life');
    send(s, st, null, { dead: 1 });
    st.life = 0;
}

function onRaidEnd(socket, r) {
    if (!socket || !r || !r.played) return;
    const st = add(socket, L.raidXp(r.place, true) * 1000);
    if (st) flush(socket, st, Date.now(), 'raid');
}

function tick(t = Date.now()) {
    if (t - lastTickAt < TICK_MS) return;
    const dt = lastTickAt ? Math.min(2 * TICK_MS, t - lastTickAt) : 0;
    lastTickAt = t;
    if (!on()) return;
    for (const s of clients()) {
        if (!s || s.terminated) continue;
        const b = s.player && s.player.body;
        if (!b || b.socket !== s || (b.isDead && b.isDead()) || b.royaleAlive === false || b.royaleLobby || b.royaleFrozen) continue;
        const st = stateOf(s);
        if (!st || !dt) continue;
        const since = s.lastInputAt ? t - s.lastInputAt : -1;
        if (since < 0 || since > ACTIVE_MS) continue;
        st.milli += dt * L.XP.minute * 1000 / 60000;
    }
    for (const s of Array.from(live)) if (s.terminated || !s._lv) onClose(s);
    if (t - lastSaveAt >= SAVE_MS) {
        lastSaveAt = t;
        for (const s of live) if (s._lv) flush(s, s._lv, t);
    }
}

function onClose(socket) {
    live.delete(socket);
    const st = socket && socket._lv;
    if (st) flush(socket, st);
}

function saveAll() { for (const s of live) if (s._lv) flush(s, s._lv); }

function socketFor(owner) {
    for (const s of clients()) {
        if (!s || s.terminated) continue;
        const o = ownerOf(s);
        if (o && o.kind === owner.kind && o.id === owner.id) return s;
    }
    return null;
}

function resolve(who) {
    if (!who) return { socket: null, owner: null };
    if (typeof who.talk === 'function') return { socket: who, owner: ownerOf(who) };
    if (who.socket && typeof who.socket.talk === 'function') return { socket: who.socket, owner: ownerOf(who.socket) };
    if (who.kind === 'a' || who.kind === 'g') return { socket: socketFor(who), owner: { kind: who.kind, id: who.id } };
    return { socket: null, owner: null };
}

function grant(who, xp, reason, opts) {
    const n = Math.max(0, Math.min(L.XP.grantMax, Math.floor(+xp || 0)));
    if (!n) return null;
    const r = resolve(who);
    const why = String(reason || 'grant').slice(0, 24);
    if (r.socket) {
        if (!(opts && opts.idleOk === true) && idleMs(r.socket, Date.now()) > IDLE_MS) return null;
        const st = add(r.socket, n * 1000);
        return st ? flush(r.socket, st, Date.now(), why) : null;
    }
    if (r.owner && store().validOwner(r.owner)) {
        try { return store().addXp(r.owner, n, why); } catch (e) { logErr('grant', e); }
    }
    return null;
}

function adoptGuest(socket, guestId, userId) {
    let res = null;
    if (socket && socket._lv) flush(socket, socket._lv);
    try { res = store().adoptGuest(userId, guestId); } catch (e) { logErr('adopt', e); return null; }
    if (!res || !res.moved) return res;
    if (socket) {
        live.delete(socket);
        socket._lv = undefined;
        const st = stateOf(socket);
        if (st) send(socket, st, { ups: res.ups, gained: 0 }, { adopted: 1 });
        if (res.dustMilli > 0) {
            try {
                require('./dustHooks').noteExternalCredit(userId, res.dustMilli, res.balanceMilli);
                bridge().du(socket, res.dustMilli, 7, true);
            } catch (e) { void e; }
        }
    }
    return res;
}

const api = {
    SAVE_MS, on, stateOf, tick, flush, saveAll, onClose, onBank, onDeath, onRaidEnd, grant, adoptGuest,
    _force(v) { forced = v; }, _live: live, _reset() { lastTickAt = 0; lastSaveAt = 0; },
};
for (const k of Object.keys(api)) {
    const fn = api[k];
    if (!/^on[A-Z]|^tick$|^grant$|^adoptGuest$/.test(k) || typeof fn !== 'function') continue;
    api[k] = function guarded(a, b, c, d) {
        try { return fn(a, b, c, d); } catch (e) { logErr(k, e); return undefined; }
    };
}
global.royaleLevels = api;
module.exports = api;
