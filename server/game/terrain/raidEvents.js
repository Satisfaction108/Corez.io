// Mid-raid events: meteor ore showers and gem rain. Not every cycle, always
// announced, always optional. Meteors smash rock and seed ore in the open;
// gem rain drops loot on the safe zone's centre to pull people out of corners.
const gems = require('./gems.js');
const { ORE } = require('./terrainGrid.js');

const WARN_MS = 4500;
let ev = null;
let lastCycle = -1;
let plannedAt = 0;

function storm() { return require('./storm.js'); }
function mods() { return require('./raidMods.js'); }

function padsBlocked(tg, x, y, minD) {
    const sites = [].concat(tg.vaultSites || [], tg.outpostSites || [], tg.shopSites || []);
    return sites.some(s => (s.x - x) ** 2 + (s.y - y) ** 2 < minD * minD);
}

function compass(x, y) {
    const a = Math.atan2(y, x);
    const dirs = ["east", "southeast", "south", "southwest", "west", "northwest", "north", "northeast"];
    const i = Math.round(((a + Math.PI * 2) % (Math.PI * 2)) / (Math.PI / 4)) % 8;
    return Math.hypot(x, y) < 500 ? "the centre" : "the " + dirs[i];
}

function oreGem(x, y, weightsShard) {
    const r = Math.random();
    const ore = r < weightsShard ? ORE.SHARD : r < 0.5 ? ORE.VEIN : ORE.COPPER;
    const value = { [ORE.SHARD]: 150, [ORE.VEIN]: 30, [ORE.COPPER]: 15 }[ore];
    const cls = { [ORE.SHARD]: 'gemPickupShard', [ORE.VEIN]: 'gemPickupVein', [ORE.COPPER]: 'gemPickupCopper' }[ore];
    const ang = Math.random() * Math.PI * 2, sp = 1.5 + Math.random() * 2.5;
    const gem = gems.spawnGem(x, y, Math.round(value * mods().gemValueMult(ore)), cls, ore === ORE.SHARD ? 26 : ore === ORE.VEIN ? 20 : 16,
        Math.cos(ang) * sp, Math.sin(ang) * sp, ore);
    if (gem) gem.gemNoMagnetUntil = Date.now() + 900;
}

function startMeteor(t) {
    const tg = global.gameManager.terrainGrid;
    const st = storm().snapshot(t);
    let spot = null;
    for (let i = 0; i < 20 && !spot; i++) {
        const a = Math.random() * Math.PI * 2, d = Math.sqrt(Math.random()) * Math.max(300, (st.r || 1000) * 0.7);
        const x = st.cx + Math.cos(a) * d, y = st.cy + Math.sin(a) * d;
        if (tg && padsBlocked(tg, x, y, 600)) continue;
        if (tg && Math.hypot(x, y) > (tg.circleRadius || 3000) - 300) continue;
        spot = { x, y };
    }
    if (!spot) return null;
    ev = { kind: 'meteor', x: Math.round(spot.x), y: Math.round(spot.y), r: 380, at: t, liveAt: t + WARN_MS, until: t + WARN_MS + 7000, hits: 0, nextHit: t + WARN_MS, where: compass(spot.x, spot.y) };
    return ev;
}

function startRain(t) {
    const st = storm().snapshot(t);
    ev = { kind: 'rain', x: Math.round(st.cx), y: Math.round(st.cy), r: 560, at: t, liveAt: t + WARN_MS, until: t + WARN_MS + 26000, nextDrop: t + WARN_MS, drops: 0, where: "the safe zone" };
    return ev;
}

function meteorHit(t) {
    const tg = global.gameManager.terrainGrid;
    const a = Math.random() * Math.PI * 2, d = Math.sqrt(Math.random()) * ev.r * 0.85;
    const hx = ev.x + Math.cos(a) * d, hy = ev.y + Math.sin(a) * d;
    if (tg && tg.rocks) {
        for (const rock of tg.rocks.values()) {
            if (!rock || (!rock.alive && !rock.growing) || rock.canyon) continue;
            const rx = rock.worldCx || rock.wx, ry = rock.worldCy || rock.wy;
            if ((rx - hx) ** 2 + (ry - hy) ** 2 > 95 * 95) continue;
            const wasGrowing = rock.growing;
            const destroyed = tg.damageRock(rock, rock.health + 1, rx, ry, false, null);
            if (destroyed && !wasGrowing && rock.ore) gems.spawnOreBurst(rock, null);
        }
    }
    const n = 2 + ((Math.random() * 3) | 0);
    for (let i = 0; i < n; i++) oreGem(hx + (Math.random() - 0.5) * 40, hy + (Math.random() - 0.5) * 40, 0.12);
    try { require('../gamemodes/scripts/dig_royale.js').fxAt(hx, hy, 'meteor'); } catch { /* */ }
}

function tick(t) {
    const st = storm().snapshot(t);
    if ((st.c | 0) !== lastCycle) {
        lastCycle = st.c | 0;
        const chance = Math.min(1, 0.55 * mods().num('eventRateMult', 1));
        plannedAt = process.env.ROYALE_DEBUG ? t + 30_000 : (Math.random() < chance ? t + 40_000 + Math.random() * 200_000 : 0);
    }
    if (ev) {
        if (t >= ev.liveAt && ev.kind === 'meteor' && t >= ev.nextHit && ev.hits < 11) {
            ev.nextHit = t + 550 + Math.random() * 250;
            ev.hits++;
            meteorHit(t);
        }
        if (t >= ev.liveAt && ev.kind === 'rain' && t >= ev.nextDrop && ev.drops < 36) {
            ev.nextDrop = t + 650;
            ev.drops++;
            const a = Math.random() * Math.PI * 2, d = Math.sqrt(Math.random()) * ev.r;
            oreGem(ev.x + Math.cos(a) * d, ev.y + Math.sin(a) * d, 0.08);
        }
        if (t > ev.until) ev = null;
        return;
    }
    if (plannedAt && t >= plannedAt && !storm().locked(t)) {
        plannedAt = 0;
        const started = Math.random() < 0.6 ? startMeteor(t) : startRain(t);
        if (started) { try { require('../gamemodes/scripts/dig_royale.js').onEvent(started); } catch { /* */ } }
    }
}

function snapshot() {
    return ev ? { kind: ev.kind, x: ev.x, y: ev.y, r: ev.r, liveAt: ev.liveAt, until: ev.until } : null;
}
function current() { return ev; }
function reset() { ev = null; lastCycle = -1; plannedAt = 0; }

module.exports = { tick, snapshot, current, reset, startMeteor, startRain };
