// The first minutes of a raid, made to pay:
//
//   early ore   at raid start every drop pit gets a soft azurite vein a few
//               cells away, and now and then an amethyst shard, so the first
//               rocks anyone shoots are worth more than copper
//   the rush    RUSH_AT_MS in, a meteor shower comes down around the busiest
//               player (raidEvents.startMeteor, moved there): rock smashed,
//               shards and veins raining, everyone pulled together
//
// ROYALE_EARLY_ORE=0 and ROYALE_RUSH=0 turn them off.
'use strict';

const ORE_ON = process.env.ROYALE_EARLY_ORE !== '0';
const RUSH_ON = process.env.ROYALE_RUSH !== '0';
const RUSH_AT_MS = 90_000;
const PIT_RING = [150, 420];
const SHARD_CHANCE = 0.18;
const SOFT = 0.6;                  // of a fresh rock's health

let hooks = {};
let rushed = false;

// dig_royale.js: humans(), fighters(), compass(x, y), onEvent(ev), raidAge(t), live()
function attach(h) { hooks = h || {}; }
function enabled() { return !!Config.dig_royale && !Config.tutorial; }
function tg() { return global.gameManager && global.gameManager.terrainGrid; }
const alive = (b) => !!b && !b.isGhost && !(b.isDead && b.isDead());

// one soft vein near every pit (sometimes a shard too); returns how many rocks
function seedPits() {
    if (!ORE_ON || !enabled()) return 0;
    const grid = tg();
    if (!grid || !grid.rocks || !grid.spawnPits) return 0;
    const { ORE, ORE_HP } = require('./terrainGrid.js');
    if (global.royaleMods && global.royaleMods.ore === 'copper') return 0;
    const rocks = [...grid.rocks.values()].filter(r => r && r.alive && !r.growing && !r.canyon && (r.ore || 0) <= ORE.COPPER && r.worldPoly);
    let n = 0;
    for (const p of grid.spawnPits) {
        const ring = rocks.filter(r => { const d = Math.hypot((r.worldCx || r.wx) - p.x, (r.worldCy || r.wy) - p.y); return d >= PIT_RING[0] && d <= PIT_RING[1]; });
        if (!ring.length) continue;
        const want = Math.random() < SHARD_CHANCE ? [ORE.VEIN, ORE.SHARD] : [ORE.VEIN];
        for (const ore of want) {
            const i = (Math.random() * ring.length) | 0;
            const rock = ring.splice(i, 1)[0];
            if (!rock) break;
            rock.ore = ore;
            try { rock.deposits = grid._buildDeposits(rock); } catch { rock.deposits = null; }
            rock.maxHealth = Math.max(10, grid.plainRockHealth * (ORE_HP[ore] || 1) * SOFT);
            rock.health = rock.maxHealth;
            grid.rockEvents.push({ k: rock.k, h: 1, d: 0, ore, bl: 1 });
            n++;
        }
    }
    return n;
}

// a meteor shower around the player with the most company
function rush(t) {
    const raidEvents = require('./raidEvents.js');
    if (raidEvents.current()) return null;
    const people = (hooks.humans ? hooks.humans() : []).filter(alive);
    if (!people.length) return null;
    const fighters = (hooks.fighters ? hooks.fighters() : []).filter(alive);
    let best = people[0], bestN = -1;
    for (const b of people) {
        const n = fighters.filter(o => o !== b && Math.hypot(o.x - b.x, o.y - b.y) < 1400).length;
        if (n > bestN) { bestN = n; best = b; }
    }
    const ev = raidEvents.startMeteor(t);
    if (!ev) return null;
    // round them, not on them: the middle of the shower a little way off
    const a = Math.random() * Math.PI * 2, d = 260 + Math.random() * 160;
    const grid = tg();
    const mapR = ((grid && grid.circleRadius) || 2700) - 420;
    let x = best.x + Math.cos(a) * d, y = best.y + Math.sin(a) * d;
    const m = Math.hypot(x, y);
    if (m > mapR) { x *= mapR / m; y *= mapR / m; }
    ev.x = Math.round(x); ev.y = Math.round(y);
    if (hooks.compass) ev.where = hooks.compass(ev.x, ev.y);
    ev.rush = true;
    if (hooks.onEvent) { try { hooks.onEvent(ev); } catch { /* */ } }
    return ev;
}

function tick(t) {
    if (!RUSH_ON || !enabled() || rushed || (hooks.live && !hooks.live())) return;
    const age = hooks.raidAge ? hooks.raidAge(t) : 0;
    if (age < RUSH_AT_MS) return;
    rushed = true;
    rush(t);
}

function newRaid() {
    rushed = false;
    return seedPits();
}

module.exports = { ORE_ON, RUSH_ON, RUSH_AT_MS, attach, tick, newRaid, seedPits, rush };
