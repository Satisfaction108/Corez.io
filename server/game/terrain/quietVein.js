// Quiet stretches, per player
'use strict';

const TUNE = {
    QUIET_MS: 65_000,
    PING_MS: 12_000,        // how long the client keeps the arrow up
    FIND_R: [250, 2400],    // rich ore this far from the player
    CLUSTER_R: 300,
    COOLDOWN_MS: 150_000,
    SETTLE_MS: 20_000,      // into a life
    FIGHT_MS: 10_000,       // shot or shooting this recently: not quiet
    IDLE_MS: 20_000,        // no input this long: they're not playing
};
let ON = process.env.ROYALE_QUIET_VEIN !== '0';
function setEnabled(v) { ON = !!v; }

const alive = (b) => !!b && !b.isGhost && !(b.isDead && b.isDead());
const DIRS = ["east", "southeast", "south", "southwest", "west", "northwest", "north", "northeast"];
function dirTo(dx, dy) {
    const a = Math.atan2(dy, dx);
    return DIRS[Math.round(((a + Math.PI * 2) % (Math.PI * 2)) / (Math.PI / 4)) % 8];
}

// The nearest rich ore cluster (vein tier and up) near `body`: a seed rock plus
function findRich(body, t = Date.now()) {
    const grid = global.gameManager && global.gameManager.terrainGrid;
    if (!grid || !grid.rocks || !body) return null;
    const { ORE } = require('./terrainGrid.js');
    let pads = [];
    try { pads = [...require('./vault.js').getVaults(), ...require('./shop.js').getShops()]; } catch { /* */ }
    const padGeom = require('./padGeom.js');
    let storm = null;
    try { storm = require('./storm.js'); } catch { /* */ }
    const VAL = { [ORE.VEIN]: 30, [ORE.SHARD]: 150, [ORE.EMERALD]: 500 };
    const rich = [];
    for (const r of grid.rocks.values()) {
        if (!r || !r.alive || r.growing || !((r.ore | 0) >= ORE.VEIN)) continue;
        const x = r.worldCx || r.wx, y = r.worldCy || r.wy;
        const d = Math.hypot(x - body.x, y - body.y);
        if (d < TUNE.FIND_R[0] || d > TUNE.FIND_R[1]) continue;
        if (storm && storm.inStorm(x, y, t)) continue;
        if (pads.some(p => padGeom.insidePad(p, x, y, 80))) continue;
        rich.push({ x, y, d, v: VAL[r.ore] || 30 });
    }
    if (!rich.length) return null;
    let best = null, bestS = -Infinity;
    const R2 = TUNE.CLUSTER_R * TUNE.CLUSTER_R;
    for (const a of rich) {
        let gems = 0, sx = 0, sy = 0, n = 0;
        for (const b of rich) {
            if ((a.x - b.x) ** 2 + (a.y - b.y) ** 2 > R2) continue;
            gems += b.v; sx += b.x * b.v; sy += b.y * b.v; n++;
        }
        const score = gems / (300 + a.d);
        if (score > bestS) { bestS = score; best = { x: Math.round(sx / gems), y: Math.round(sy / gems), rocks: n, gems }; }
    }
    return best;
}

// humans: live player bodies
function tick(humans, scoreOf, raid, t = Date.now(), fire = null) {
    if (!ON || (typeof Config !== 'undefined' && Config.tutorial)) return 0;
    if (global.royaleFinal90) return 0;
    let n = 0;
    for (const b of humans || []) {
        const sock = b && b.socket;
        if (!sock || !alive(b)) continue;
        const score = +(scoreOf ? scoreOf(b) : 0) || 0, carry = b.carriedGems | 0;
        let q = sock._qv;
        if (!q || q.raid !== raid || q.body !== b) {
            sock._qv = q = { raid, body: b, score, carry, gainAt: t, firedAt: q && q.raid === raid ? q.firedAt : 0 };
            continue;
        }
        if (score > q.score || carry > q.carry) q.gainAt = t;
        q.score = score; q.carry = carry;
        if (Math.max(b._lastDamageAt || 0, b.hitAt || 0) > t - TUNE.FIGHT_MS) { q.gainAt = Math.max(q.gainAt, t - TUNE.QUIET_MS + 15_000); continue; }
        if (t - q.gainAt < TUNE.QUIET_MS || t - q.firedAt < TUNE.COOLDOWN_MS) continue;
        if (t - (b.royaleBornAt || 0) < TUNE.SETTLE_MS) continue;
        try { if (require('../network/activity.js').inputIdleMs(sock, t) > TUNE.IDLE_MS) continue; } catch { /* */ }
        try { if (require('./storm.js').inStorm(b.x, b.y, t)) continue; } catch { /* */ }
        // a newcomer moment of their own is already on
        const nx = sock._nx && sock._nx.event;
        if (nx && nx.state === 'live') continue;
        let ev = null;
        try { ev = (fire || findRich)(b, t); } catch { ev = null; }
        // nowhere to put one: look again in a while
        q.firedAt = t;
        q.gainAt = t;
        if (!ev || ev === 'skip') { q.firedAt = t - TUNE.COOLDOWN_MS + 30_000; continue; }
        n++;
        try { sock.talk('m', 6000, "Rich vein close by, to your " + dirTo(ev.x - b.x, ev.y - b.y) + ". Follow the arrow to it."); } catch { /* */ }
        try { sock.talk('FX', Math.round(ev.x), Math.round(ev.y), 'veinping', TUNE.PING_MS); } catch { /* */ }
        try { sock.talk('FX', Math.round(ev.x), Math.round(ev.y), 'bloom'); } catch { /* */ }
    }
    return n;
}

module.exports = { TUNE, tick, setEnabled, findRich };
