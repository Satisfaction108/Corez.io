// Respawn build buttons (round 9, Oct 5 2026): "Respawn as <Tank>" on the death
'use strict';

const autoStats = require('./autoStats.js');

const ON = process.env.ROYALE_BUILD_BUTTONS !== '0';
const MODES = ['build', 'tank', 'stats', 'random'];
const MAX_DEPTH = 8;
// set by dig_royale.js: the raid a saved build belongs to
let raidOf = () => 0;
function setRaidOf(fn) { if (typeof fn === 'function') raidOf = fn; }

const cls = (d) => { try { return ensureIsClass(d); } catch { return null; } };
function spawnClass() { return String((typeof Config !== 'undefined' && Config.spawn_class) || 'basic'); }

// a class's children: every single-class entry of its UPGRADES_TIER_n lists
function children(def) {
    const set = cls(def);
    const out = [];
    if (!set) return out;
    const cap = (typeof Config !== 'undefined' && Config.tier_cap) || 10;
    for (let i = 0; i < cap; i++) {
        const list = set['UPGRADES_TIER_' + i];
        if (!list) continue;
        for (let e of list) {
            if (Array.isArray(e)) { if (e.length !== 1) continue; e = e[0]; }
            const c = cls(e);
            if (c && !out.includes(c)) out.push(c);
        }
    }
    return out;
}
// Pure (given kids): the classes to step through from `from` to `to`, not
function pathTo(from, to, kids = children, depth = MAX_DEPTH) {
    const a = cls(from), b = cls(to);
    if (!a || !b) return null;
    if (a === b) return [];
    if (depth <= 0) return null;
    for (const k of kids(a)) {
        const rest = pathTo(k, b, kids, depth - 1);
        if (rest) return [k, ...rest];
    }
    return null;
}

const sum = (r) => (r || []).reduce((a, v) => a + (v | 0), 0);
function isUpgraded(defs) {
    if (!defs || !defs.length) return false;
    if (defs.length !== 1) return true;
    const d = cls(defs[0]), s = cls(spawnClass());
    return !!d && d !== s;
}

// Oct 6 2026 playtest: the saved build lived only on the socket, so a reconnect
// (reload, network blip, a raid-worker hop) lost it and the death card offered
// no "Respawn as". It is also kept by the player's stable keys (resume token,
// account) and the new socket adopts it.
const byKey = new Map();
function keysOf(socket) {
    const out = [];
    if (!socket) return out;
    if (socket.resumeToken) out.push('t:' + socket.resumeToken);
    if (socket.account && socket.account.id) out.push('a:' + socket.account.id);
    return out;
}
function remember(socket, l) {
    for (const k of keysOf(socket)) byKey.set(k, l);
    if (byKey.size > 4000) { for (const k of byKey.keys()) { byKey.delete(k); if (byKey.size <= 3000) break; } }
}
function adopt(socket) {
    if (!socket || socket._rbLast) return socket && socket._rbLast;
    for (const k of keysOf(socket)) {
        const l = byKey.get(k);
        if (l && l.raid === raidOf()) { socket._rbLast = l; return l; }
    }
    return null;
}

// dig_royale onDeath: what this life played
function save(socket, body, raid) {
    if (socket) adopt(socket);
    if (!ON || !socket || !body || !body.skill) return null;
    const defs = (body.defs || []).slice();
    const raw = body.skill.raw ? Array.from(body.skill.raw) : [];
    const up = isUpgraded(defs) && defs.length === 1;
    if (!up && !sum(raw)) return socket._rbLast || null;
    const prev = socket._rbLast && socket._rbLast.raid === raid ? socket._rbLast : null;
    const d = up ? cls(defs[0]) : null;
    socket._rbLast = {
        raid,
        def: d || (prev && prev.def) || null,
        name: d ? String(d.LABEL || body.label || 'Tank') : (prev && prev.name) || '',
        raw: sum(raw) ? raw : (prev ? prev.raw : raw),
    };
    remember(socket, socket._rbLast);
    return socket._rbLast;
}
function last(socket) {
    const l = socket && (socket._rbLast || adopt(socket));
    return l && l.raid === raidOf() ? l : null;
}
// the RY you-packet: lt = last tank's name, ltu = 1 while the tank button would
function youFields(socket, body) {
    const l = last(socket);
    if (!ON || !l) return null;
    const out = {};
    if (l.def && l.name) out.lt = l.name;
    if (sum(l.raw)) out.ls = 1;
    if (l.def && body && body.defs && body.defs.length === 1) {
        const cur = cls(body.defs[0]);
        const key = (cur && cur.index) + '>' + l.def.index;
        if (socket._rbAncKey !== key) {
            socket._rbAncKey = key;
            const p = cur ? pathTo(cur, l.def) : null;
            socket._rbAnc = !!(p && p.length);
        }
        if (socket._rbAnc) out.ltu = 1;
    }
    return out;
}

// one step up the live menu to class `c`; -> true when it took
function stepTo(body, c) {
    const ups = body.upgrades || [];
    for (let i = 0; i < ups.length; i++) {
        const u = ups[i];
        if (!u || u.branch !== 0 || !u.class || u.class.length !== 1 || u.redefineAll) continue;
        if (cls(u.class[0]) !== c) continue;
        if (body.skill.level < u.level) return false;
        const before = body.defs && body.defs[0];
        body.upgrade(i, 0);
        return cls(body.defs && body.defs[0]) === c && before !== body.defs[0];
    }
    return false;
}
function applyTank(body, l) {
    if (!l || !l.def || !body.defs || body.defs.length !== 1) return false;
    const p = pathTo(body.defs[0], l.def);
    if (!p || !p.length) return false;
    let moved = false;
    for (const c of p) { if (!stepTo(body, c)) break; moved = true; }
    return moved;
}
// Pure: the saved spread on top of `raw`, paid from `points`, capped
function fitOnTop(raw, saved, points, caps) {
    const out = Array.from(raw || []);
    let left = Math.max(0, points | 0);
    for (let i = 0; i < (saved || []).length && left > 0; i++) {
        const cap = caps && caps[i] != null ? caps[i] | 0 : 9;
        const want = (saved[i] | 0) - (out[i] | 0);
        const n = Math.max(0, Math.min(want, cap - (out[i] | 0), left));
        if (n > 0) { out[i] = (out[i] | 0) + n; left -= n; }
    }
    return { raw: out, left };
}
// Pure: a random but sensible spread: autoStats' template as weights, jittered
function randomFit(raw, points, caps, rammer = false, rand = Math.random) {
    const tpl = rammer ? autoStats.RAM_BUILD : autoStats.GUN_BUILD;
    const out = Array.from(raw || []);
    while (out.length < tpl.length) out.push(0);
    const w = tpl.map((v) => (v > 0 ? v * (0.4 + 1.2 * rand()) : 0));
    let left = Math.max(0, points | 0);
    const cap = (i) => (caps && caps[i] != null ? caps[i] | 0 : 9);
    for (let guard = 0; left > 0 && guard < 400; guard++) {
        let tot = 0;
        for (let i = 0; i < w.length; i++) if (out[i] < cap(i)) tot += w[i];
        if (tot <= 0) {
            // every weighted stat is full: anything still open
            const i = out.findIndex((v, j) => v < cap(j));
            if (i < 0) break;
            out[i]++; left--; continue;
        }
        let r = rand() * tot, pick = -1;
        for (let i = 0; i < w.length; i++) {
            if (out[i] >= cap(i) || w[i] <= 0) continue;
            pick = i; r -= w[i];
            if (r <= 0) break;
        }
        out[pick]++; left--;
    }
    return { raw: out, left };
}
function setRaw(body, fit) {
    const sk = body.skill;
    sk.set(fit.raw);
    sk.points = fit.left;
    body.refreshBodyAttributes();
    if (body.syncSkillsToGuns) body.syncSkillsToGuns();
}
function applyStats(body, l) {
    const sk = body.skill;
    if (!l || !sum(l.raw) || !((sk.points | 0) > 0)) return false;
    const fit = fitOnTop(sk.raw, l.raw, sk.points, sk.caps);
    if (fit.left === (sk.points | 0)) return false;
    setRaw(body, fit);
    return true;
}
function applyRandom(body, rand = Math.random) {
    let moved = false;
    for (let d = 0; d < MAX_DEPTH; d++) {
        const ups = (body.upgrades || []).filter((u) => u && u.branch === 0 && u.class && u.class.length === 1 && !u.redefineAll && body.skill.level >= u.level);
        if (!ups.length) break;
        const u = ups[Math.floor(rand() * ups.length) % ups.length];
        if (!stepTo(body, cls(u.class[0]))) break;
        moved = true;
    }
    const sk = body.skill;
    if ((sk.points | 0) > 0) {
        const rammer = !(body.guns && (typeof body.guns.size === 'number' ? body.guns.size : body.guns.length));
        setRaw(body, randomFit(sk.raw, sk.points, sk.caps, rammer, rand));
        moved = true;
    }
    return moved;
}

// The "rb" packet
function request(socket, mode) {
    if (!ON || !socket || typeof mode !== 'string' || !MODES.includes(mode)) return '';
    if (typeof Config !== 'undefined' && (!Config.dig_royale || Config.tutorial)) return '';
    const body = socket.player && socket.player.body;
    const dead = !body || (body.isDead && body.isDead());
    if (dead) {
        // only the death card's button, and only with a build to come back to
        if (mode !== 'build') return '';
        socket._rbWant = !!last(socket);
        return socket._rbWant ? 'queued' : '';
    }
    if (body.socket && body.socket !== socket) return '';
    if (body.royaleFrozen || (global.royaleInFall && global.royaleInFall(body))) return '';
    const l = last(socket);
    try {
        if (mode === 'random') return applyRandom(body) ? 'random' : '';
        if (!l) return '';
        let did = '';
        if (mode === 'tank' || mode === 'build') did += applyTank(body, l) ? 'tank' : '';
        if (mode === 'stats' || mode === 'build') did += applyStats(body, l) ? 'stats' : '';
        return did;
    } catch (e) {
        console.error('[RB]', e && e.message);
        return '';
    }
}
// sockets.initalizePlayer after the level fill: a "Respawn as" spawn
function onSpawn(socket, body) {
    if (!socket || !socket._rbWant) return false;
    socket._rbWant = false;
    const l = last(socket);
    if (!ON || !l || !body || !body.skill) return false;
    try {
        applyTank(body, l);
        const sk = body.skill;
        const pool = (sk.points | 0) + sum(sk.raw);
        // the fresh body's pool, spread the way the last life had it
        const base = new Array((sk.raw || []).length).fill(0);
        const fit = fitOnTop(base, l.raw || [], pool, sk.caps);
        setRaw(body, fit);
        try { body.sendMessage("Back in your " + (body.label || "tank") + " with the same stats."); } catch { /* */ }
        return true;
    } catch (e) {
        console.error('[RB] spawn', e && e.message);
        return false;
    }
}

module.exports = { byKey, ON, MODES, setRaidOf, children, pathTo, save, last, youFields, fitOnTop, randomFit, request, onSpawn, applyTank, applyStats, applyRandom };
