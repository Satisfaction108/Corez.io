'use strict';

const S = require('./aoSchedule.js');

function on() {
    return process.env.ROYALE_ALWAYS_ON !== '0' && !!(global.Config && Config.dig_royale) && !Config.tutorial && !Config.royale_duos;
}

let hooks = {};
function attach(h) { hooks = h || {}; }
function hook(name, ...a) {
    const f = hooks[name];
    if (typeof f !== 'function') return undefined;
    try { return f(...a); } catch (e) { logErr(name, e); return undefined; }
}
const errAt = new Map();
function logErr(what, e) {
    const t = Date.now();
    if (t - (errAt.get(what) || 0) < 10000) return;
    errAt.set(what, t);
    console.error('[ALWAYS-ON] ' + what + ' failed:', (e && e.stack) || e);
}

const mods = {};
function m(name) { return mods[name] || (mods[name] = require('./' + name + '.js')); }
function tg() { return global.gameManager && global.gameManager.terrainGrid; }
function mapR() { const g = tg(); return (g && g.circleRadius) || 4000; }
const alive = (b) => !!b && !b.isGhost && !(b.isDead && b.isDead());
const nameOf = (b) => String((b && b.name) || (b && b.isBot ? 'A bot' : 'A player')).slice(0, 24);
const fmt = (n) => Math.round(+n || 0).toLocaleString('en-US');
function fmtClock(ms) {
    const s = Math.max(0, Math.ceil(ms / 1000));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

const st = {
    started: false,
    history: [],
    lastRegion: null,
    lastVault: null,
    next: null,
    cur: null,
    res: null,
    seq: 0,
    lastStartAt: 0,
    lastEndAt: 0,
    botAt: 0,
};

const daily = {
    day: null,
    offset: 0,
    champs: [],
    champsDay: null,
    saveAt: 0,
    loaded: false,
};

function rng() { return Math.random(); }
function tanksNow() { const f = hook('fighters') || []; return f.length; }
function scale() { return S.scaleFor(tanksNow()); }
function keyOf(b) { return hook('keyOf', b) || null; }
function colorOf(b) {
    if (!b) return undefined;
    const bc = b.leaderboardColor != null ? b.leaderboardColor : b.color && b.color.base;
    if (typeof bc === 'number') return bc;
    return /^\d+$/.test(String(bc)) ? +bc : undefined;
}

function vaults() { try { return m('vault').getVaults() || []; } catch { return []; } }
function nearestVault(x, y, skip) {
    let best = null, bd = Infinity;
    for (const v of vaults()) {
        if (skip && v.x === skip.x && v.y === skip.y && vaults().length > 1) continue;
        const d = Math.hypot(v.x - x, v.y - y);
        if (d < bd) { bd = d; best = v; }
    }
    return best;
}
function padNear(x, y, minD) {
    const g = tg();
    const sites = [].concat((g && g.vaultSites) || [], (g && g.outpostSites) || [], (g && g.shopSites) || []);
    return sites.some(s => (s.x - x) ** 2 + (s.y - y) ** 2 < minD * minD);
}
function clampToMap(x, y, keep) {
    const R = Math.max(200, mapR() - keep);
    const d = Math.hypot(x, y);
    if (d <= R) return { x, y };
    return { x: x / d * R, y: y / d * R };
}
function rockDensest(x, y, searchR, r) {
    const g = tg();
    if (!g || !g.rocks) return { x, y };
    const list = [];
    for (const rock of g.rocks.values()) {
        if (!rock || !rock.alive || rock.canyon) continue;
        const rx = rock.worldCx || rock.wx, ry = rock.worldCy || rock.wy;
        if ((rx - x) ** 2 + (ry - y) ** 2 > searchR * searchR) continue;
        list.push([rx, ry]);
    }
    if (list.length < 6) return { x, y };
    let best = { x, y }, bn = -1;
    for (let i = 0; i < 30; i++) {
        const c = list[(Math.random() * list.length) | 0];
        if (padNear(c[0], c[1], 420)) continue;
        let n = 0;
        for (const p of list) if ((p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2 <= r * r) n++;
        if (n > bn) { bn = n; best = { x: c[0], y: c[1] }; }
    }
    return best;
}

function entryOf(ev, body) {
    const key = keyOf(body);
    if (!key) return null;
    let e = ev.scores.get(key);
    if (!e) {
        e = { key, name: nameOf(body), pts: 0, at: Date.now(), isBot: !body.socket, c: colorOf(body), body, held: 0 };
        ev.scores.set(key, e);
    }
    e.body = body;
    e.name = nameOf(body);
    e.c = colorOf(body);
    return e;
}
function score(ev, body, n) {
    if (!ev || !body || !(n > 0)) return;
    const e = entryOf(ev, body);
    if (!e) return;
    e.pts += n;
    e.at = Date.now();
}
function setScore(ev, body, n) {
    const e = entryOf(ev, body);
    if (!e) return;
    if (Math.round(n) !== Math.round(e.pts)) e.at = Date.now();
    e.pts = Math.max(0, n);
}

function inside(b, x, y, r) { return (b.x - x) ** 2 + (b.y - y) ** 2 <= r * r; }

function trackCarry(ev, fighters, r) {
    for (const b of fighters) {
        if (!alive(b) || b.royaleFrozen) continue;
        const c = Math.max(0, b.carriedGems | 0);
        const prev = b._aoCarryId === ev.id ? (b._aoCarry | 0) : c;
        b._aoCarryId = ev.id;
        b._aoCarry = c;
        const delta = c - prev;
        if (delta > 0 && inside(b, ev.x, ev.y, r)) {
            const e = entryOf(ev, b);
            if (e) e.held += delta;
        }
    }
}

const STORM_DMG_MULT = 0.85;
const STORM_HOLD_MS = 20_000;
function stormRadius(ev, t) {
    const d = ev.data;
    const k = Math.max(0, Math.min(1, (t - ev.startAt) / d.shrinkMs));
    return d.R0 - (d.R0 - d.rEnd) * k;
}
function stormProgress(ev, t) { return Math.max(0, Math.min(1, (t - ev.startAt) / ev.data.shrinkMs)); }
function stormCenter(ev, t) {
    const k = stormProgress(ev, t);
    return { x: ev.x * k, y: ev.y * k };
}
function inRing(ev, b, t) {
    if (Math.hypot(b.x, b.y) > ev.data.R0) return false;
    const c = stormCenter(ev, t);
    return Math.hypot(b.x - c.x, b.y - c.y) > stormRadius(ev, t);
}

function stormDamage(ev, t, fighters) {
    const storm = m('storm');
    for (const body of fighters) {
        if (!alive(body) || body.royaleFrozen || body.adminSpec) continue;
        const dt = body._stormSeenAt ? Math.max(0, Math.min(250, t - body._stormSeenAt)) : 0;
        body._stormSeenAt = t;
        if (!inRing(ev, body, t)) {
            body._inStorm = false;
            if (body._stormExpMs > 0) {
                body._stormOutMs = (body._stormOutMs || 0) + dt;
                if (body._stormOutMs >= storm.RAMP_RESET_MS) { body._stormExpMs = 0; body._stormOutMs = 0; body._stormHurtAt = 0; }
            }
            continue;
        }
        body._inStorm = true;
        body._stormOutMs = 0;
        if ((body.spawnGraceUntil || 0) > t) continue;
        body.invuln = false;
        let dmgMult = 1;
        if (body.socket) { try { dmgMult = m('shop').stormDamageMult(body); } catch { } }
        if (dmgMult <= 0) continue;
        body._stormExpMs = (body._stormExpMs || 0) + dt;
        if (t - (body._stormHurtAt || 0) < storm.DAMAGE_EVERY_MS) continue;
        body._stormHurtAt = t;
        if (!body.health || !(body.health.max > 0)) continue;
        const dmg = body.health.max * storm.DAMAGE_FRAC * storm.rampMult(body._stormExpMs / 1000) * STORM_DMG_MULT * dmgMult;
        if (body.shield && body.shield.amount > 0) {
            const soak = Math.min(body.shield.amount, dmg);
            body.shield.amount -= soak;
            body.health.amount -= (dmg - soak);
        } else body.health.amount -= dmg;
        if (body.health.amount <= 0) {
            body.deathCause = "storm";
            body.dontSendDeathMessage = true;
            if (body.sendMessage) body.sendMessage("The storm circle closed in on you.");
        }
    }
}
function clearStormMarks(fighters) {
    for (const b of fighters || []) { b._inStorm = false; b._stormExpMs = 0; b._stormOutMs = 0; b._stormHurtAt = 0; }
}

function releaseBots(id) {
    for (const b of hook('fighters') || []) {
        if (b._aoBotEv === id) { b._botDirectorPoint = null; b._botDirectorUntil = 0; b._aoBotJoin = false; b._aoGoalPt = null; }
    }
}
const CONTESTED_SHARE = 0.5;
const BOT_SHARE = { storm: 0.75, core: 0.8, boss: 0.75, rush: 0.7, hill: 0.75, meteor: 0.65 };
const SOON_SHARE = 0.6;
function botJoins(b, id, share) {
    if (b._aoBotEv !== id) { b._aoBotEv = id; b._aoBotJoin = rng() < share; b._aoGoalPt = null; }
    return !!b._aoBotJoin;
}
function spotIn(b, x, y, r0, r1, key) {
    const p = b._aoGoalPt;
    if (p && p.key === key) return p;
    const a = rng() * Math.PI * 2, d = r0 + Math.sqrt(rng()) * Math.max(0, r1 - r0);
    return (b._aoGoalPt = { key, x: x + Math.cos(a) * d, y: y + Math.sin(a) * d });
}
function standOff(b, x, y, R) {
    const dx = b.x - x, dy = b.y - y, d = Math.hypot(dx, dy);
    if (d >= R - 120 && d <= R + 260) return null;
    const ux = d > 1 ? dx / d : 1, uy = d > 1 ? dy / d : 0;
    return { kind: 'go', x: x + ux * R, y: y + uy * R, arrive: 180 };
}
function areaGoal(b, x, y, r0, r1, key) {
    const d = Math.hypot(b.x - x, b.y - y);
    if (d >= r0 && d <= r1) return { kind: 'here' };
    const p = spotIn(b, x, y, r0, r1, key);
    return { kind: 'go', x: p.x, y: p.y, arrive: Math.max(90, Math.min(220, (r1 - r0) * 0.35)) };
}
function botGoal(b, t = Date.now()) {
    if (!on() || !b || !b.isBot || b.isTeamBot || !alive(b)) return null;
    const ev = st.cur;
    if (ev) {
        if (!botJoins(b, ev.id, BOT_SHARE[ev.kind] || 0.7)) return null;
        let g = null;
        if (ev.kind === 'core') {
            const c = m('coreFinale').current();
            if (c) g = { kind: 'shoot', target: c, x: c.x, y: c.y, r: c.realSize || c.size || 100, fight: true };
            else g = standOff(b, ev.x, ev.y, 760);
        } else if (ev.kind === 'boss') {
            const bo = m('bosses').current();
            if (bo) g = { kind: 'boss', target: bo, x: bo.x, y: bo.y, fight: true };
            else g = standOff(b, ev.x, ev.y, 820);
        } else if (ev.kind === 'storm' && ev.data && ev.data.R0) {
            const c = stormCenter(ev, t);
            const rNow = stormRadius(ev, t);
            if (stormProgress(ev, t) >= 0.75 && !inside(b, c.x, c.y, rNow * 1.15) && !botJoins(b, ev.id + ':fin', 0.35)) return null;
            const r = Math.min(rNow * 0.7, stormRadius(ev, t + 90_000) * 0.8);
            g = areaGoal(b, c.x, c.y, 0, Math.max(80, r), 's' + ev.id + ':' + Math.round(r / 150));
            if (g) g.fight = true;
        } else if (ev.kind === 'rush') {
            if (ev.data && t < ev.data.richUntil) g = areaGoal(b, ev.x, ev.y, 0, ev.r * 0.75, 'r' + ev.id);
        } else if (ev.kind === 'hill') {
            g = areaGoal(b, ev.x, ev.y, (ev.padR || 130) + 50, ev.r - 50, 'h' + ev.id);
        } else if (ev.kind === 'meteor') {
            g = areaGoal(b, ev.x, ev.y, 0, ev.r * 0.8, 'm' + ev.id);
        }
        return g && g.kind !== 'here' ? g : null;
    }
    const n = st.next;
    if (n && n.announced && n.startAt - t <= 30_000) {
        if (!botJoins(b, 'n' + n.plannedAt, SOON_SHARE)) return null;
        let g;
        if (n.kind === 'boss' || n.kind === 'core') g = standOff(b, n.x, n.y, 1000);
        else if (n.kind === 'hill') g = areaGoal(b, n.x, n.y, (n.padR || 130) + 50, (n.r || 500) - 50, 'nh' + n.plannedAt);
        else g = areaGoal(b, n.x, n.y, 0, (n.r || 500) * 0.6, 'n' + n.plannedAt);
        return g && g.kind !== 'here' ? g : null;
    }
    return null;
}
function shareScores(ev, list, total) {
    const by = new Map();
    for (const h of list) {
        if (!h || !h.body) continue;
        const k = keyOf(h.body);
        if (!k) continue;
        let e = by.get(k);
        if (!e) by.set(k, e = { body: h.body, share: 0, at: -1 });
        e.share += h.share || 0;
        if ((h.at || 0) >= e.at) { e.at = h.at || 0; e.body = h.body; }
    }
    for (const e of by.values()) setScore(ev, e.body, Math.round(total * e.share));
    return by;
}
function spotFor(ev, size, offVault) {
    const ES = m('eventSpot');
    let ov = null;
    if (offVault) { try { const bm = m('bosses'); ov = (x, y) => !bm.nearVault(x, y); } catch (e) { ov = null; } }
    const p = ES.pick(ev.x, ev.y, { size, fighters: hook('fighters') || [], offVault: ov });
    ev.x = p.x; ev.y = p.y;
    ev.where = S.compassName(p.x, p.y, mapR());
    return p;
}

const EVENTS = {
    storm: {
        plan(region, sc) {
            const p = clampToMap(region.x, region.y, sc.stormEnd + 500);
            return { x: p.x, y: p.y, r: sc.stormEnd };
        },
        start(ev, t, sc) {
            const R0 = mapR();
            ev.data = { R0, rEnd: sc.stormEnd, shrinkMs: Math.max(30_000, ev.ms - STORM_HOLD_MS), lastPt: t };
            return true;
        },
        tick(ev, t, fighters) {
            stormDamage(ev, t, fighters);
            const r = stormRadius(ev, t), c = stormCenter(ev, t);
            if (t - ev.data.lastPt < 1000) return false;
            const secs = Math.min(3, (t - ev.data.lastPt) / 1000);
            ev.data.lastPt = t;
            const k = stormProgress(ev, t);
            for (const b of fighters) {
                if (!alive(b) || b.royaleFrozen || !inside(b, c.x, c.y, r)) continue;
                score(ev, b, (2 + 4 * k) * secs);
            }
            return false;
        },
        onDeath(ev, victim, killer, t) {
            if (!killer || !alive(killer)) return;
            if (!inside(victim, 0, 0, ev.data.R0)) return;
            const c = stormCenter(ev, t);
            if (!inside(killer, c.x, c.y, stormRadius(ev, t) + 60)) return;
            score(ev, killer, 150);
        },
        end(ev, t, fighters, natural) {
            const r = stormRadius(ev, t), c = stormCenter(ev, t);
            if (natural) for (const b of fighters) if (alive(b) && !b.royaleFrozen && inside(b, c.x, c.y, r)) score(ev, b, 300);
            clearStormMarks(fighters);
        },
        snap(ev, t) {
            const c = stormCenter(ev, t);
            return { R: Math.round(ev.data.R0), rr: Math.round(stormRadius(ev, t)), re: Math.round(ev.data.rEnd), cx: Math.round(c.x), cy: Math.round(c.y) };
        },
    },
    core: {
        plan(region) {
            const v = nearestVault(region.x, region.y, st.lastVault) || { x: 0, y: 0, r: 95 };
            let ang = Math.atan2(region.y - v.y, region.x - v.x);
            if (Math.hypot(region.x - v.x, region.y - v.y) < 60) ang = Math.random() * Math.PI * 2;
            const off = m('coreFinale').CORE_OFFSET || 330;
            const p = clampToMap(v.x + Math.cos(ang) * off, v.y + Math.sin(ang) * off, 420);
            return { x: p.x, y: p.y, r: 640, vault: { x: v.x, y: v.y, r: v.r } };
        },
        start(ev, t, sc) {
            const cf = m('coreFinale');
            const p = spotFor(ev, 120, false);
            const o = cf.startAt(ev.x, ev.y, { vault: ev.vault, hpMult: sc.coreHp, gems: sc.coreGems, spewR: 1100, riseMs: cf.RISE_MS || 1800 });
            ev.data = { gems: sc.coreGems, downAt: 0, killer: null, spot: p };
            return !!o;
        },
        tick(ev, t, fighters) {
            const cf = m('coreFinale');
            shareScores(ev, cf.hitterList(), 1500);
            const s = cf.state();
            if (s === 'down' && !ev.data.downAt) {
                ev.data.downAt = t;
                const list = cf.hitterList().filter(h => h.body).sort((a, b) => (b.at || 0) - (a.at || 0));
                ev.data.killer = list.length ? list[0].body : null;
            }
            if (s === 'idle') return true;
            return !!ev.data.downAt && t - ev.data.downAt > 3500;
        },
        end(ev, t) {
            const cf = m('coreFinale');
            if (ev.data && ev.data.killer) score(ev, ev.data.killer, 400);
            const s = cf.state();
            if (s === 'up' || s === 'rising') {
                const how = cf.explode ? cf.explode(t) : (cf.clear(), 'gone');
                if (how === 'blown') {
                    hook('feed', { ao: 1, coreblast: 1, n: ev.name });
                    hook('toast', "Time's up! The Core overloaded and blew itself apart before anyone could break it.", 6000);
                }
            }
        },
        snap(ev) { return { g: ev.data ? ev.data.gems : 0 }; },
    },
    boss: {
        plan(region) {
            const bm = m('bosses');
            const p0 = clampToMap(region.x, region.y, 500);
            const p = bm.clearOfVaults ? bm.clearOfVaults(p0) : p0;
            return { x: p.x, y: p.y, r: 700 };
        },
        start(ev, t) {
            const bm = m('bosses');
            if (bm.current() || (bm.exiting && bm.exiting()) || (bm.pendingRise && bm.pendingRise())) bm.burrow();
            const ids = Object.keys(bm.KINDS || {});
            const kind = ids.length ? ids[(Math.random() * ids.length) | 0] : undefined;
            const p = spotFor(ev, 110, true);
            const at = { x: ev.x, y: ev.y, ms: ev.ms + 5000, home: 650 };
            const o = bm.rise ? bm.rise(kind, at, t) : bm.spawn(kind, at);
            ev.data = { boss: o && !o.due ? o : null, rising: !!(o && o.due), killer: null, dead: false, spot: p };
            if (kind && bm.KINDS[kind]) ev.data.bossName = bm.KINDS[kind].name;
            return !!o;
        },
        tick(ev, t) {
            const bm = m('bosses');
            shareScores(ev, bm.hitterList(), 1200);
            if (ev.data.rising) {
                if (bm.pendingRise && bm.pendingRise()) return false;
                ev.data.rising = false;
                ev.data.boss = bm.current();
                if (ev.data.boss) ev.data.bossName = ev.data.boss.name;
            }
            const b = ev.data.boss;
            if (b && alive(b)) { ev.x = b.x; ev.y = b.y; }
            return ev.data.dead || !b || !alive(b);
        },
        onBossDead(ev, o, killer, burrowed) {
            if (ev.data.boss !== o) return;
            ev.data.dead = true;
            if (!burrowed && killer) ev.data.killer = killer;
        },
        end(ev) {
            const bm = m('bosses');
            if (ev.data.killer) score(ev, ev.data.killer, 400);
            if (ev.data.boss && alive(ev.data.boss) && !ev.data.dead) { if (!(bm.exit && bm.exit())) bm.burrow(); }
            else if (bm.pendingRise && bm.pendingRise()) bm.burrow();
        },
        snap(ev) { return { bn: ev.data && ev.data.bossName ? String(ev.data.bossName) : undefined }; },
    },
    rush: {
        plan(region, sc) {
            const p0 = clampToMap(region.x, region.y, sc.rushR + 200);
            const p = rockDensest(p0.x, p0.y, 900, sc.rushR);
            return { x: p.x, y: p.y, r: sc.rushR };
        },
        start(ev, t) {
            const RICH = 150_000;
            const b = m('blooms').start({ x: ev.x, y: ev.y, r: ev.r, ms: RICH });
            ev.data = { richUntil: t + RICH, bloom: b, lastAt: 0 };
            return true;
        },
        tick(ev, t, fighters) {
            if (t - ev.data.lastAt < 250) return false;
            ev.data.lastAt = t;
            if (t < ev.data.richUntil) trackCarry(ev, fighters, ev.r + 120);
            return false;
        },
        onBanked(ev, body, amount) {
            const e = ev.scores.get(keyOf(body));
            if (!e || !(e.held > 0)) return;
            const take = Math.min(e.held, Math.max(0, amount | 0));
            e.held -= take;
            if (take > 0) { e.pts += take * 0.5; e.at = Date.now(); }
        },
        onDeath(ev, victim) {
            const e = ev.scores.get(keyOf(victim));
            if (e) e.held = 0;
        },
        end(ev) {
            const bl = m('blooms');
            const cur = bl.current();
            if (cur && ev.data && cur === ev.data.bloom) bl.stop();
        },
        snap(ev, t) { return { ru: Math.max(0, ev.data.richUntil - t) }; },
    },
    hill: {
        plan(region, sc) {
            const v = nearestVault(region.x, region.y, st.lastVault) || { x: 0, y: 0, r: 95 };
            const padR = (v.r || 95) * ((m('padGeom').OCT || {}).scale || 1.4);
            return { x: v.x, y: v.y, r: Math.round(padR + sc.hillR), vault: { x: v.x, y: v.y, r: v.r }, padR: Math.round(padR) };
        },
        start(ev, t, sc) {
            ev.data = { lastPt: t, pps: sc.hillPps, contested: false, holder: '', on: 0 };
            st.lastVault = ev.vault;
            return true;
        },
        tick(ev, t, fighters) {
            if (t - ev.data.lastPt < 1000) return false;
            const secs = Math.min(3, (t - ev.data.lastPt) / 1000);
            ev.data.lastPt = t;
            const onHill = fighters.filter(b => alive(b) && !b.royaleFrozen && !b.onVaultPad && !b.padSafe && inside(b, ev.x, ev.y, ev.r));
            const teams = new Set(onHill.map(b => b.team));
            ev.data.contested = teams.size > 1;
            ev.data.on = onHill.length;
            ev.data.holder = onHill.length && !ev.data.contested ? nameOf(onHill[0]) : '';
            ev.data.names = onHill.slice(0, 4).map(b => nameOf(b).slice(0, 16));
            const rate = ev.data.contested ? ev.data.pps * CONTESTED_SHARE : ev.data.pps;
            for (const b of onHill) score(ev, b, rate * secs);
            return false;
        },
        end() { },
        snap(ev) { return { pr: ev.padR, ct: ev.data.contested ? 1 : 0, h: ev.data.holder || undefined, on: ev.data.on | 0, ns: ev.data.contested ? ev.data.names : undefined }; },
    },
    meteor: {
        plan(region) {
            let p = clampToMap(region.x, region.y, 600);
            for (let i = 0; i < 8 && padNear(p.x, p.y, 560); i++) p = clampToMap(p.x + (Math.random() - 0.5) * 600, p.y + (Math.random() - 0.5) * 600, 600);
            return { x: p.x, y: p.y, r: 520 };
        },
        start(ev, t) {
            ev.data = { nextVolley: t, volleys: 0, lastAt: 0 };
            return true;
        },
        tick(ev, t, fighters) {
            const re = m('raidEvents');
            if (t >= ev.data.nextVolley && !re.current() && ev.until - t > 13_000) {
                ev.data.volleys++;
                ev.data.nextVolley = t + 13_500;
                const a = Math.random() * Math.PI * 2, d = Math.random() * 120;
                re.startMeteorAt(t, ev.x + Math.cos(a) * d, ev.y + Math.sin(a) * d, 380, 12);
            }
            if (t - ev.data.lastAt < 250) return false;
            ev.data.lastAt = t;
            for (const b of fighters) {
                if (!alive(b) || b.royaleFrozen) continue;
                const c = Math.max(0, b.carriedGems | 0);
                const prev = b._aoCarryId === ev.id ? (b._aoCarry | 0) : c;
                b._aoCarryId = ev.id;
                b._aoCarry = c;
                if (c > prev && inside(b, ev.x, ev.y, ev.r + 160)) score(ev, b, c - prev);
            }
            return false;
        },
        end() { },
        snap(ev) { return { v: ev.data.volleys | 0 }; },
    },
};

const FIRST_MS = () => S.envMs('ROYALE_AO_FIRST_MS', S.FIRST_MS);

function planNext(t, startAt, forceKind) {
    const kind = forceKind && EVENTS[forceKind] ? forceKind : S.pickKind(st.history, rng);
    const region = S.pickRegion(S.regions(mapR()), st.lastRegion, rng, mapR());
    const sc = scale();
    let spot = null;
    try { spot = EVENTS[kind].plan(region, sc); } catch (e) { logErr('plan ' + kind, e); }
    if (!spot) spot = { x: region.x, y: region.y, r: 600 };
    st.next = {
        kind, region, x: Math.round(spot.x), y: Math.round(spot.y), r: Math.round(spot.r || 600), vault: spot.vault || null, padR: spot.padR || 0,
        where: S.compassName(spot.x, spot.y, mapR()), startAt: Math.round(startAt), announced: false, plannedAt: t,
    };
    return st.next;
}

function announce(t) {
    const n = st.next;
    if (!n || n.announced) return;
    n.announced = true;
    if (n.kind === 'rush') {
        try {
            const sc = scale();
            const p = rockDensest(n.x, n.y, 500, n.r || sc.rushR);
            n.x = Math.round(p.x); n.y = Math.round(p.y);
        } catch (e) { logErr('rush refine', e); }
    }
    const K = S.KINDS[n.kind];
    const secs = Math.max(1, Math.round((n.startAt - t) / 1000));
    hook('toast', K.name + " starts in " + secs + " seconds in " + n.where + ". " + K.verb, 7000);
    hook('feed', { ao: 1, soon: 1, k: n.kind, n: K.name, w: n.where });
    hook('fxAt', n.x, n.y, 'aosoon', n.r | 0);
}

function startEvent(t) {
    const n = st.next;
    if (!n) return null;
    st.next = null;
    const K = S.KINDS[n.kind];
    const ev = {
        id: ++st.seq, kind: n.kind, name: K.name, where: n.where, x: n.x, y: n.y, r: n.r, vault: n.vault, padR: n.padR,
        region: n.region, startAt: t, ms: K.ms, until: t + K.ms, scores: new Map(), data: {},
    };
    let ok = false;
    try { ok = EVENTS[n.kind].start(ev, t, scale()); } catch (e) { logErr('start ' + n.kind, e); ok = false; }
    st.history.push(n.kind);
    if (st.history.length > 24) st.history.shift();
    st.lastRegion = n.region;
    st.lastStartAt = t;
    if (!ok) {
        st.lastEndAt = t;
        hook('toast', K.name + " couldn't start this time, so the next event comes a little sooner.", 5000);
        planNext(t, t + 90_000);
        return null;
    }
    st.cur = ev;
    hook('announceAll', 'aostart', K.name.toUpperCase(), K.verb + " It's in " + ev.where + ".", 3600);
    hook('fxAt', ev.x, ev.y, 'aostart', ev.r | 0);
    hook('feed', { ao: 1, go: 1, k: ev.kind, n: K.name, w: ev.where });
    return ev;
}

function finish(t, natural = true) {
    const ev = st.cur;
    if (!ev) return null;
    st.cur = null;
    const fighters = hook('fighters') || [];
    try { EVENTS[ev.kind].end(ev, t, fighters, natural); } catch (e) { logErr('end ' + ev.kind, e); }
    releaseBots(ev.id);
    const awards = S.awardsFor(ev.scores);
    for (const a of awards) hook('addEvPts', a.key, a.pts, ev.name + " " + S.ordinal(a.place), a.place, ev.name);
    const crowned = crownsFor(ev, awards.slice(0, 3));
    try { m('crowns').awardEvent(crowned.bodies, t, ev.name, crowned.waiting); } catch (e) { logErr('crowns', e); }
    const byKey = new Map();
    for (const a of awards) byKey.set(a.key, { place: a.place, pts: a.pts });
    st.res = {
        id: ev.id, k: ev.kind, n: ev.name, at: t, count: awards.length,
        top: awards.slice(0, 3).map(a => ({ n: String(a.name || 'A player').slice(0, 16), p: a.pts, c: a.c, b: a.isBot ? 1 : 0 })),
        byKey,
    };
    hook('onEventEnd', ev, awards);
    const w = awards[0];
    hook('feed', { ao: 1, done: 1, k: ev.kind, n: ev.name, by: w ? w.name : '' });
    if (w) hook('toast', ev.name + " is over. " + w.name + " won it" + (awards[1] ? ", with " + awards[1].name + " in second" : "") + ".", 6000);
    else hook('toast', ev.name + " is over. Nobody scored this time.", 5000);
    st.lastEndAt = t;
    planNext(t, S.nextStartAt(ev.startAt, t, rng));
    return st.res;
}

function liveBodyOf(key, ev) {
    const b = hook('bodyOfKey', key);
    if (b !== undefined) return b && alive(b) && keyOf(b) === key ? b : null;
    const e = ev && ev.scores.get(key);
    return e && alive(e.body) && keyOf(e.body) === key ? e.body : null;
}
function crownsFor(ev, top) {
    const bodies = [], waiting = [];
    for (const a of top) {
        const b = liveBodyOf(a.key, ev);
        if (b) { bodies.push(b); continue; }
        if (hook('keyPresent', a.key)) waiting.push({ key: a.key, name: a.name, place: a.place });
    }
    return { bodies, waiting };
}

function tick(t, fighters) {
    if (!on()) return;
    if (!st.started) {
        st.started = true;
        planNext(t, t + FIRST_MS());
    }
    tickDaily(t);
    const ev = st.cur;
    if (ev) {
        let done = false;
        try { done = !!EVENTS[ev.kind].tick(ev, t, fighters || []); } catch (e) { logErr('tick ' + ev.kind, e); }
        if (done || t >= ev.until) finish(t, !done || ev.kind !== 'core');
        return;
    }
    const n = st.next;
    if (!n) { planNext(t, t + 60_000); return; }
    if (!n.announced && t >= n.startAt - S.WARN_MS) announce(t);
    if (t >= n.startAt) startEvent(t);
}

function onDeath(victim, killer) {
    const ev = st.cur;
    if (!ev || !victim) return;
    const K = EVENTS[ev.kind];
    if (K.onDeath) { try { K.onDeath(ev, victim, killer, Date.now()); } catch (e) { logErr('death', e); } }
}
function onBanked(body, amount) {
    const ev = st.cur;
    if (!ev || !body) return;
    const K = EVENTS[ev.kind];
    if (K.onBanked) { try { K.onBanked(ev, body, amount); } catch (e) { logErr('banked', e); } }
}
function onBossDead(o, kind, killer, burrowed) {
    const ev = st.cur;
    if (!ev || ev.kind !== 'boss') return;
    try { EVENTS.boss.onBossDead(ev, o, killer, burrowed); } catch (e) { logErr('boss dead', e); }
}

function current() { return st.cur; }
function nextEvent() { return st.next; }

function stormSnapshot(t = Date.now()) {
    const ev = st.cur;
    if (!ev || ev.kind !== 'storm' || !ev.data || !ev.data.R0) return null;
    const r = stormRadius(ev, t), n = stormRadius(ev, t + 250);
    const c = stormCenter(ev, t), nc = stormCenter(ev, t + 250);
    const hold = t - ev.startAt >= ev.data.shrinkMs;
    return { a: 1, ao: 1, cx: Math.round(c.x), cy: Math.round(c.y), nx: Math.round(nc.x), ny: Math.round(nc.y), tx: ev.x, ty: ev.y, r: Math.round(r), n: Math.round(n), max: Math.round(ev.data.R0), out: Math.round(ev.data.R0),
        to: Math.round(ev.data.rEnd), c: 0, cn: 0, fin: 0, hold: hold ? 1 : 0, left: Math.max(0, Math.ceil((ev.until - t) / 1000)), lock: 0, lockLeft: 0, gmul: 1 };
}
function stormFlee(body, t = Date.now()) {
    const ev = st.cur;
    if (!ev || ev.kind !== 'storm' || !body || !inRing(ev, body, t)) return null;
    const r = Math.max(40, stormRadius(ev, t) - 90), c = stormCenter(ev, t);
    const d = Math.hypot(body.x - c.x, body.y - c.y) || 1;
    return { x: c.x + (body.x - c.x) / d * r, y: c.y + (body.y - c.y) / d * r };
}
function exposure(body, t = Date.now()) {
    const ev = st.cur;
    if (!ev || ev.kind !== 'storm' || !body || !body._inStorm) return 0;
    try { return Math.round(m('storm').rampMult((body._stormExpMs || 0) / 1000) * STORM_DMG_MULT * 100) / 100; } catch { return 0; }
}

function spawnZones() {
    const out = [];
    const ev = st.cur;
    if (ev && ev.kind !== 'storm') out.push({ x: ev.x, y: ev.y, r: ev.r + 250 });
    const n = st.next;
    if (n && n.announced && n.kind !== 'storm') out.push({ x: n.x, y: n.y, r: (n.r || 600) + 200 });
    return out;
}

function topOf(ev, n = 3) {
    return S.ranked(ev.scores).slice(0, n).map(e => ({ n: String(e.name || 'A player').slice(0, 16), p: Math.round(e.pts), c: e.c, b: e.isBot ? 1 : 0 }));
}

function snapshot(t = Date.now()) {
    if (!on()) return undefined;
    const n = st.next, ev = st.cur, res = st.res;
    const dayKey = daily.day || S.dayKey(t + daily.offset * S.DAY_MS);
    let ft = undefined;
    try { ft = m('dailyTanks').forDay(dayKey); } catch { }
    const out = {
        on: 1, day: dayKey, rs: Math.max(0, resetAt(t) - t),
        ch: daily.champs.slice(0, 3).map(c => ({ n: String(c.name || 'Unnamed').slice(0, 16), p: c.score | 0 })),
        ft,
    };
    if (n) {
        out.nx = { k: n.kind, n: S.KINDS[n.kind].name, w: n.where, in: Math.max(0, n.startAt - t), a: n.announced ? 1 : 0 };
        if (n.announced) { out.nx.x = n.x; out.nx.y = n.y; out.nx.r = n.r; if (n.padR) out.nx.pr = n.padR; }
    }
    if (ev) {
        out.ev = { id: ev.id, k: ev.kind, n: ev.name, w: ev.where, x: Math.round(ev.x), y: Math.round(ev.y), r: ev.r, left: Math.max(0, ev.until - t), ms: ev.ms, top: topOf(ev) };
        try { Object.assign(out.ev, EVENTS[ev.kind].snap(ev, t) || {}); } catch (e) { logErr('snap', e); }
    }
    if (res && t - res.at < 14_000) out.res = { id: res.id, k: res.k, n: res.n, top: res.top, ago: t - res.at, count: res.count };
    return out;
}
function liveEventPts(key) {
    if (!on() || !key || !st.cur) return 0;
    const e = st.cur.scores.get(key);
    return e && e.pts > 0 ? Math.min(S.ACTIVITY_CAP, Math.round(e.pts)) : 0;
}

function youFields(key, t = Date.now()) {
    if (!on() || !key) return undefined;
    const out = {};
    const ev = st.cur;
    if (ev) {
        const p = S.placeOf(ev.scores, key);
        out.ep = p.pts;
        out.epl = p.place;
        out.eof = p.of;
        if (ev.kind === 'rush') { const e = ev.scores.get(key); if (e && e.held > 0) out.eh = Math.round(e.held); }
    }
    const res = st.res;
    if (res && t - res.at < 14_000) {
        const r = res.byKey.get(key);
        out.rr = r ? { id: res.id, pl: r.place, p: r.pts } : { id: res.id, pl: 0, p: 0 };
    }
    return out;
}

function deathText(t = Date.now()) {
    const ev = st.cur, n = st.next;
    if (ev) return ev.name + " is on in " + ev.where + " for " + fmtClock(ev.until - t) + ".";
    if (n) return "Next event in " + fmtClock(n.startAt - t) + ": " + S.KINDS[n.kind].name + " in " + n.where + ".";
    return "";
}

function resetAt(t = Date.now()) {
    const off = daily.offset * S.DAY_MS;
    return S.nextResetAt(t + off) - off;
}
function dayNow(t = Date.now()) { return S.dayKey(t + daily.offset * S.DAY_MS); }
function store() { try { return require('../../accounts/dailyScores.js'); } catch { return null; } }
function worldId() { return String((global.gameManager && global.gameManager.port) || 'main'); }

function tickDaily(t) {
    if (!daily.day) {
        daily.day = dayNow(t);
        loadChamps(t);
        loadWorld(t);
        daily.saveAt = t;
    }
    if (dayNow(t) !== daily.day) { doReset(t); return; }
    if (t - daily.saveAt >= 10_000) { daily.saveAt = t; saveAll(t); }
}
function yesterdayOf(day) {
    const ms = Date.parse(day + 'T00:00:00Z');
    return S.dayKey(ms - S.DAY_MS);
}
function loadChamps(t) {
    const ds = store();
    if (!ds || !ds.available()) return;
    try {
        const y = yesterdayOf(daily.day);
        daily.champs = ds.champs(y);
        daily.champsDay = y;
    } catch (e) { logErr('load champs', e); }
}
function loadWorld(t) {
    const ds = store();
    if (!ds || !ds.available()) return;
    try {
        const rows = ds.loadWorld(daily.day, worldId());
        hook('loadRows', rows);
        daily.loaded = true;
    } catch (e) { logErr('load world', e); }
    try { hook('loadBots', ds.loadBots(daily.day, worldId())); } catch (e) { logErr('load bots', e); }
}
function loadOne(who) {
    const ds = store();
    if (!ds || !ds.available() || !who) return null;
    try { return ds.loadOne(daily.day || dayNow(), who); } catch (e) { logErr('load one', e); return null; }
}
function saveAll(t = Date.now(), all = false) {
    const ds = store();
    if (!ds || !ds.available()) return 0;
    const day = daily.day || dayNow(t);
    try {
        const bots = hook('saveBots', all) || { rows: [], gone: [] };
        if (bots.rows && bots.rows.length) ds.saveBots(day, worldId(), bots.rows, t);
        if (bots.gone && bots.gone.length) ds.dropBots(day, worldId(), bots.gone);
    } catch (e) { logErr('save bots', e); }
    const rows = hook('saveRows', all) || [];
    if (!rows.length) return 0;
    try { return ds.save(day, worldId(), rows, t); } catch (e) { logErr('save', e); return 0; }
}
function doReset(t, forced = false) {
    const oldDay = daily.day || dayNow(t);
    saveAll(t, true);
    const fallback = (hook('humanRows') || []).slice().sort((a, b) => b.score - a.score);
    let champs = [];
    const ds = store();
    if (ds && ds.available()) {
        try {
            const r = ds.settleDay(oldDay, t, fallback);
            champs = r.champs || [];
            if (r.fresh) { try { ds.dailyPlacement(oldDay, t); } catch (e) { logErr('daily placement', e); } }
        } catch (e) { logErr('settle', e); }
    } else {
        champs = fallback.filter(r => r.score > 0).slice(0, 3).map((r, i) => ({ place: i + 1, who: r.who, name: r.name, score: r.score, dustMilli: 0, paid: false }));
    }
    if (forced) daily.offset++;
    daily.day = dayNow(t);
    if (ds && ds.available()) { try { ds.pruneBots(daily.day); } catch (e) { logErr('prune bots', e); } }
    daily.champs = champs;
    daily.champsDay = oldDay;
    daily.saveAt = t;
    hook('dailyReset', champs, oldDay, daily.day);
    return { oldDay, day: daily.day, champs };
}
function ready() { return !!daily.day; }
function champUntil(who, t = Date.now()) {
    if (!who) return 0;
    for (const c of daily.champs) if (c.who === who) return resetAt(t);
    return 0;
}
function champPlace(who) {
    for (const c of daily.champs) if (c.who === who) return c.place | 0;
    return 0;
}

function debugStart(kind, t = Date.now()) {
    if (st.cur) finish(t, false);
    planNext(t, t, kind && EVENTS[kind] ? kind : undefined);
    st.next.announced = true;
    return startEvent(t);
}
function debugNext(t = Date.now()) {
    if (st.cur) return { ended: finish(t, true) };
    if (!st.next) planNext(t, t);
    st.next.startAt = t;
    if (!st.next.announced) announce(t);
    return { started: startEvent(t) };
}
function debugPlan(kind, sec, t = Date.now()) {
    if (st.cur) finish(t, false);
    planNext(t, t + Math.max(1, +sec || 60) * 1000, kind && EVENTS[kind] ? kind : undefined);
    if ((st.next.startAt - t) <= S.WARN_MS) announce(t);
    return st.next;
}
function debugLeft(sec, t = Date.now()) {
    const ev = st.cur;
    if (!ev) return null;
    const left = Math.max(1, +sec || 1) * 1000;
    const shift = (ev.until - t) - left;
    if (st.lastStartAt === ev.startAt) st.lastStartAt -= shift;
    ev.startAt -= shift;
    ev.until -= shift;
    if (ev.data && ev.data.richUntil) ev.data.richUntil -= shift;
    if (ev.data && ev.data.lastPt) ev.data.lastPt = Math.min(ev.data.lastPt, t);
    return ev.until - t;
}
function debugScore(body, n) {
    const ev = st.cur;
    if (!ev || !body) return null;
    score(ev, body, Math.max(0, +n || 0));
    return S.placeOf(ev.scores, keyOf(body));
}
function debugState(t = Date.now()) {
    return {
        on: on(), cur: st.cur ? { id: st.cur.id, k: st.cur.kind, x: Math.round(st.cur.x), y: Math.round(st.cur.y), spot: (st.cur.data && st.cur.data.spot) || null, left: st.cur.until - t, scores: S.ranked(st.cur.scores).map(e => ({ n: e.name, p: Math.round(e.pts), b: e.isBot ? 1 : 0 })) } : null,
        bots: (hook('fighters') || []).filter(b => b.isBot && !b.isTeamBot).map(b => ({ n: String(b.name || ''), g: b._digWarsGoal || '', j: b._aoBotJoin ? 1 : 0, d: st.cur ? Math.round(Math.hypot(b.x - st.cur.x, b.y - st.cur.y)) : -1 })),
        roster: (() => { try { return m('botRoster').aoState(); } catch (e) { return null; } })(),
        next: st.next ? { k: st.next.kind, in: st.next.startAt - t, a: st.next.announced, w: st.next.where, gap: st.next.startAt - st.lastStartAt, afterEnd: st.next.startAt - st.lastEndAt } : null,
        res: st.res ? { id: st.res.id, k: st.res.k, top: st.res.top, count: st.res.count } : null,
        history: st.history.slice(-8), day: daily.day, offset: daily.offset, champs: daily.champs, resetIn: resetAt(t) - t,
        errors: [...errAt.keys()],
    };
}

function _reset() {
    st.started = false; st.history = []; st.lastRegion = null; st.lastVault = null; st.next = null; st.cur = null; st.res = null; st.seq = 0;
    daily.day = null; daily.offset = 0; daily.champs = []; daily.champsDay = null; daily.saveAt = 0; daily.loaded = false;
}

module.exports = {
    on, attach, tick, botGoal, crownsFor, shareScores, BOT_SHARE, onDeath, onBanked, onBossDead, current, nextEvent, snapshot, youFields, liveEventPts, stormSnapshot, stormFlee, exposure, spawnZones,
    deathText, resetAt, dayNow, ready, champUntil, champPlace, loadOne, saveAll, doReset, worldId,
    debugStart, debugNext, debugPlan, debugLeft, debugScore, debugState, finish, EVENTS, _st: st, _daily: daily, _reset, _stormRadius: stormRadius,
};
