'use strict';

const TANK_CLEAR = 900;
const BOT_SOFT = 520;
const PAD_CLEAR = 420;
const RINGS = [0, 220, 420, 620, 820, 1020, 1260, 1520, 1800, 2100, 2450];

function tg() { return global.gameManager && global.gameManager.terrainGrid; }
const alive = (b) => !!b && !b.isGhost && !(b.isDead && b.isDead());

function padSites() {
    const g = tg();
    const out = [];
    for (const list of [g && g.vaultSites, g && g.outpostSites, g && g.shopSites]) for (const s of list || []) if (s) out.push(s);
    try { for (const v of require('./vault.js').getVaults() || []) out.push(v); } catch (e) { }
    try { for (const s of require('./shop.js').getShops() || []) out.push(s); } catch (e) { }
    return out;
}

function tankLists(fighters) {
    const humans = [], bots = [];
    for (const b of fighters || []) {
        if (!alive(b) || b.isRoyaleBoss || b.isRoyaleCore) continue;
        if (b.socket || b.isPlayer) humans.push(b); else if (b.isBot) bots.push(b);
    }
    return { humans, bots };
}

function nearest(list, x, y) {
    let best = Infinity;
    for (const b of list) {
        const d = Math.hypot(b.x - x, b.y - y);
        if (d < best) best = d;
    }
    return best;
}

const scratch = [];
function rockInfo(x, y, r) {
    const g = tg();
    if (!g || !g.rocksHitByCircle) return { n: 0, emerald: false };
    g.rocksHitByCircle(x, y, r, scratch);
    let emerald = false;
    for (const rock of scratch) if (rock && rock.ore === 4) { emerald = true; break; }
    const n = scratch.length;
    scratch.length = 0;
    return { n, emerald };
}

function inMap(x, y, margin) {
    const g = tg();
    if (g && g.inPlayArea) return g.inPlayArea(x, y, margin);
    const R = (g && g.circleRadius) || 4000;
    return x * x + y * y <= Math.max(0, R - margin) ** 2;
}

function pick(x0, y0, opts = {}) {
    const size = Math.max(30, +opts.size || 80);
    const clear = opts.clear > 0 ? +opts.clear : TANK_CLEAR;
    const botClear = opts.botClear > 0 ? +opts.botClear : clear;
    const margin = size + (opts.margin > 0 ? +opts.margin : 260);
    const fighters = opts.fighters || [];
    const { humans, bots } = tankLists(fighters);
    const pads = opts.pads || padSites();
    const avoid = opts.avoid || [];
    const offVault = typeof opts.offVault === 'function' ? opts.offVault : null;
    const padR = PAD_CLEAR + size;
    const cands = [];
    for (let ri = 0; ri < RINGS.length; ri++) {
        const R = RINGS[ri];
        const n = R === 0 ? 1 : Math.max(8, Math.round(R / 110));
        const rot = ri * 0.61;
        for (let i = 0; i < n; i++) {
            const a = rot + i * Math.PI * 2 / n;
            const x = x0 + Math.cos(a) * R, y = y0 + Math.sin(a) * R;
            if (!inMap(x, y, margin)) continue;
            let bad = false;
            for (const p of pads) if ((p.x - x) ** 2 + (p.y - y) ** 2 < padR * padR) { bad = true; break; }
            if (bad) continue;
            for (const z of avoid) if ((z.x - x) ** 2 + (z.y - y) ** 2 < (z.r || 0) ** 2) { bad = true; break; }
            if (bad) continue;
            if (offVault && !offVault(x, y)) continue;
            cands.push({ x, y, ring: ri, h: nearest(humans, x, y), b: nearest(bots, x, y) });
        }
    }
    const tiers = [
        (c) => c.h >= clear && c.b >= botClear,
        (c) => c.h >= clear && c.b >= BOT_SOFT,
        (c) => c.h >= clear,
        (c) => c.h >= clear * 0.75,
    ];
    for (const ok of tiers) {
        let best = null, bestScore = Infinity;
        for (const c of cands) {
            if (!ok(c)) continue;
            const info = rockInfo(c.x, c.y, size + 40);
            if (info.emerald) continue;
            const score = c.ring * 10 + info.n * 2.5;
            if (score < bestScore) { bestScore = score; best = c; }
        }
        if (best) return { x: Math.round(best.x), y: Math.round(best.y), human: Math.round(best.h), bot: Math.round(best.b), tier: tiers.indexOf(ok) };
    }
    let far = null;
    for (const c of cands) if (!far || c.h > far.h) far = c;
    if (far) return { x: Math.round(far.x), y: Math.round(far.y), human: Math.round(far.h), bot: Math.round(far.b), tier: tiers.length };
    return { x: Math.round(x0), y: Math.round(y0), human: Math.round(nearest(humans, x0, y0)), bot: Math.round(nearest(bots, x0, y0)), tier: tiers.length + 1 };
}

function clearRock(x, y, r) {
    const g = tg();
    if (!g || !g.rocksHitByCircle || !g.damageRock) return 0;
    const list = [];
    g.rocksHitByCircle(x, y, r, list);
    let n = 0;
    for (const rock of list) {
        if (!rock || rock.ore === 4) continue;
        try { if (g.damageRock(rock, rock.health + rock.maxHealth + 1, rock.worldCx || rock.wx, rock.worldCy || rock.wy, false, null)) n++; } catch (e) { }
    }
    try {
        for (const rock of g.growingRocks ? g.growingRocks() : []) {
            if (!rock || rock.ore === 4) continue;
            const rx = rock.worldCx || rock.wx, ry = rock.worldCy || rock.wy;
            if ((rx - x) ** 2 + (ry - y) ** 2 > (r + 40) ** 2) continue;
            g.damageRock(rock, rock.maxHealth * 2 + 1, rx, ry, false, null);
        }
    } catch (e) { }
    try { require('./spawnReach.js').invalidate(); } catch (e) { }
    return n;
}

function shove(x, y, r, fighters, power = 9) {
    let n = 0;
    for (const b of fighters || []) {
        if (!alive(b) || b.isRoyaleBoss || b.isRoyaleCore || !b.velocity) continue;
        const dx = b.x - x, dy = b.y - y, d = Math.hypot(dx, dy);
        const reach = r + (b.realSize || b.size || 30);
        if (d >= reach) continue;
        const ux = d > 1 ? dx / d : Math.cos(b.id || 0), uy = d > 1 ? dy / d : Math.sin(b.id || 0);
        const k = 0.45 + 0.55 * (1 - d / reach);
        b.velocity.x += ux * power * k;
        b.velocity.y += uy * power * k;
        n++;
    }
    return n;
}

module.exports = { TANK_CLEAR, BOT_SOFT, PAD_CLEAR, pick, clearRock, shove, nearest, tankLists };
