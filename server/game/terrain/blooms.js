// Ore blooms: a patch of the wall sprouts rich veins under a golden glow for
// a hundred seconds. One per storm cycle, announced, on the minimap. Everyone
// heads to the same rocks; fights follow.
const { ORE, ORE_HP } = require('./terrainGrid.js');

const RADIUS = 340;
const DURATION_MS = 100_000;

let bloom = null;
let lastCycle = -1;
let nextAt = 0;

function storm() { return require('./storm.js'); }

function padsBlocked(tg, x, y, minD) {
    const sites = [].concat(tg.vaultSites || [], tg.outpostSites || [], tg.shopSites || []);
    return sites.some(s => (s.x - x) ** 2 + (s.y - y) ** 2 < minD * minD);
}

function start() {
    const tg = global.gameManager.terrainGrid;
    if (!tg || !tg.rocks) return null;
    const st = storm().snapshot();
    const safeR = Math.max(400, (st.r || 1000) * 0.75);
    const alive = [];
    for (const rock of tg.rocks.values()) {
        if (!rock || !rock.alive || rock.canyon || rock.ore === ORE.EMERALD) continue;
        const rx = rock.worldCx || rock.wx, ry = rock.worldCy || rock.wy;
        if (Math.hypot(rx - st.cx, ry - st.cy) > safeR) continue;
        if (padsBlocked(tg, rx, ry, 560)) continue;
        alive.push(rock);
    }
    if (alive.length < 8) return null;
    // richest cluster wins: sample candidates, count alive neighbours
    let best = null, bestN = -1;
    for (let i = 0; i < 24; i++) {
        const c = alive[(Math.random() * alive.length) | 0];
        const cx = c.worldCx || c.wx, cy = c.worldCy || c.wy;
        let n = 0;
        for (const r of alive) {
            const rx = r.worldCx || r.wx, ry = r.worldCy || r.wy;
            if ((rx - cx) ** 2 + (ry - cy) ** 2 <= RADIUS * RADIUS) n++;
        }
        if (n > bestN) { bestN = n; best = { x: cx, y: cy }; }
    }
    if (!best) return null;
    const mods = require('./raidMods.js');
    const copperOnly = mods.get() && mods.get().ore === 'copper';
    const keys = [];
    for (const rock of alive) {
        const rx = rock.worldCx || rock.wx, ry = rock.worldCy || rock.wy;
        if ((rx - best.x) ** 2 + (ry - best.y) ** 2 > RADIUS * RADIUS) continue;
        const frac = rock.maxHealth > 0 ? Math.min(1, rock.health / rock.maxHealth) : 1;
        const ore = copperOnly ? ORE.COPPER : (Math.random() < 0.28 ? ORE.SHARD : ORE.VEIN);
        rock.ore = ore;
        rock.maxHealth = (tg.baseRockHealth * 1.3) * (ORE_HP[ore] || 1) * (global.royaleMods && global.royaleMods.rockHpMult || 1);
        rock.health = Math.max(1, rock.maxHealth * frac);
        try { rock.deposits = tg._buildDeposits(rock); } catch { rock.deposits = null; }
        rock.bloomed = true;
        keys.push(rock.k);
        tg.rockEvents.push({ k: rock.k, h: rock.health / rock.maxHealth, d: 0, ore, bl: 1 });
    }
    if (!keys.length) return null;
    bloom = { x: Math.round(best.x), y: Math.round(best.y), r: RADIUS, startedAt: Date.now(), until: Date.now() + DURATION_MS, rocks: keys.length };
    return bloom;
}

function tick(t) {
    const st = storm().snapshot(t);
    if (bloom && t > bloom.until) bloom = null;
    // one bloom per storm cycle, a minute or two into the shrink
    if ((st.c | 0) !== lastCycle) {
        lastCycle = st.c | 0;
        nextAt = process.env.ROYALE_DEBUG ? t + 20_000 : t + 60_000 + Math.random() * 90_000;
    }
    if (!bloom && nextAt && t >= nextAt && !st.hold && !storm().locked(t)) {
        nextAt = 0;
        const b = start();
        if (b) { try { require('../gamemodes/scripts/dig_royale.js').onBloom(b); } catch { /* */ } }
    }
}

function snapshot() { return bloom ? { x: bloom.x, y: bloom.y, r: bloom.r, until: bloom.until } : null; }
function current() { return bloom; }
function reset() { bloom = null; lastCycle = -1; nextAt = 0; }

module.exports = { tick, snapshot, current, reset, start, RADIUS };
