'use strict';

const EVERY_MS = 85;
const KIND = { boss: 1, core: 2 };

function rootOf(src) {
    let root = src, hops = 0;
    while (root && root.master && root.master !== root && hops++ < 8) root = root.master;
    return root;
}

function note(target, inflictors, dealt, t = Date.now(), kind = 'boss') {
    if (!target || !inflictors || !inflictors.length || !(dealt > 0)) return 0;
    const per = dealt / inflictors.length;
    const max = target.health && target.health.max > 0 ? target.health.max : 1;
    const hp = Math.max(0, Math.min(1, ((target.health ? target.health.amount : 0) - dealt) / max));
    let sent = 0;
    for (const src of inflictors) {
        const root = rootOf(src);
        if (!root || !root.socket || root === target) continue;
        let h = root._bigHit;
        if (!h || h.id !== target.id) h = root._bigHit = { id: target.id, dmg: 0, x: 0, y: 0, at: 0 };
        h.dmg += per;
        h.x = isFinite(src.x) ? src.x : target.x;
        h.y = isFinite(src.y) ? src.y : target.y;
        if (t - h.at < EVERY_MS) continue;
        h.at = t;
        const n = Math.max(1, Math.round(h.dmg));
        h.dmg = 0;
        try { root.socket.talk('BH', target.id | 0, n, Math.round(h.x), Math.round(h.y), KIND[kind] || 1, Math.round(hp * 1000)); sent++; } catch (e) { }
    }
    return sent;
}

module.exports = { EVERY_MS, KIND, note, rootOf };
