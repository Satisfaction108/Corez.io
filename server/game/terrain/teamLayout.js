'use strict';

const BLUE = -1, RED = -2;
const TEAMS = [BLUE, RED];
const TILE = 420;
const ROOM_TILES = 20;

const BASE_TILES = {
    [BLUE]: { gx0: 1, gx1: 2, gy0: 8, gy1: 11, prot: [[2, 8], [2, 11]] },
    [RED]: { gx0: 17, gx1: 18, gy0: 8, gy1: 11, prot: [[17, 8], [17, 11]] },
};

const BLUE_SITES = {
    bank: { x: -3360, y: 0 },
    pad: { x: -2560, y: -380 },
    shop: { x: -2560, y: 380 },
    eye: { x: -2100, y: 0 },
    tail: { x: 2560, y: -2330 },
    mouth: { x: -2700, y: 0 },
};
const NEUTRAL_SHOPS = [{ x: -760, y: 1470 }, { x: 760, y: -1470 }];
const CENTER = { x: 0, y: 0 };
const DRONE_R = 560;
const BLUE_PROTECTORS = [{ x: -3570, y: -560 }, { x: -3570, y: 560 }];
const YARD_R = 640;
const PAD_R = 95;

const LANES = {
    middle: [{ x: -2700, y: 0 }, { x: -1700, y: -330 }, { x: -600, y: -330 }, { x: 600, y: -330 }, { x: 1700, y: -330 }, { x: 2560, y: -120 }],
    flank: [{ x: -2700, y: 0 }, { x: -2350, y: -1500 }, { x: -1100, y: -2650 }, { x: 600, y: -2950 }, { x: 2000, y: -2450 }, { x: 2900, y: -1450 }, { x: 3330, y: -1150 }],
};

const mirror = p => ({ x: -p.x, y: -p.y });
const other = team => team === BLUE ? RED : BLUE;
const teamNo = team => team === BLUE ? 1 : team === RED ? 2 : 0;
const teamOfNo = n => n === 1 ? BLUE : n === 2 ? RED : 0;
const teamName = team => team === BLUE ? 'Blue' : team === RED ? 'Red' : '';
const isTeam = team => team === BLUE || team === RED;

function roomHalf() {
    const room = global.gameManager && global.gameManager.room;
    return room && room.width ? room.width / 2 : (TILE * ROOM_TILES) / 2;
}

function tileRect(gx0, gx1, gy0, gy1) {
    const h = roomHalf();
    return { x0: gx0 * TILE - h, x1: (gx1 + 1) * TILE - h, y0: gy0 * TILE - h, y1: (gy1 + 1) * TILE - h };
}

function baseRect(team) {
    const b = BASE_TILES[team];
    return b ? tileRect(b.gx0, b.gx1, b.gy0, b.gy1) : null;
}

function baseCenter(team) {
    const r = baseRect(team);
    return r ? { x: (r.x0 + r.x1) / 2, y: (r.y0 + r.y1) / 2 } : null;
}

function protectorSpots(team) {
    if (team === BLUE) return BLUE_PROTECTORS.map(p => ({ ...p }));
    if (team === RED) return BLUE_PROTECTORS.map(mirror);
    return [];
}

function sitesFor(team) {
    if (team === BLUE) return BLUE_SITES;
    const out = {};
    for (const k of Object.keys(BLUE_SITES)) out[k] = mirror(BLUE_SITES[k]);
    return out;
}

function lane(team, name) {
    const pts = LANES[name] || LANES.middle;
    return team === BLUE ? pts.map(p => ({ ...p })) : pts.map(mirror);
}

function inRect(r, x, y, pad = 0) {
    return !!r && x >= r.x0 - pad && x <= r.x1 + pad && y >= r.y0 - pad && y <= r.y1 + pad;
}

function inBase(team, x, y, pad = 0) { return inRect(baseRect(team), x, y, pad); }

function baseAt(x, y, pad = 0) {
    for (const t of TEAMS) if (inBase(t, x, y, pad)) return t;
    return 0;
}

function inDroneZone(team, x, y, pad = 0) {
    const R = DRONE_R + pad;
    for (const p of protectorSpots(team)) if ((x - p.x) ** 2 + (y - p.y) ** 2 <= R * R) return true;
    return false;
}

function territoryOf(x, y, circleR) {
    const head = (circleR || roomHalf()) / 2;
    if ((x + head) ** 2 + y * y < head * head) return BLUE;
    if ((x - head) ** 2 + y * y < head * head) return RED;
    return y < 0 ? BLUE : RED;
}

function baseSpawnSpot(team, rng = Math.random) {
    const r = baseRect(team);
    if (!r) return null;
    const bank = sitesFor(team).bank;
    for (let i = 0; i < 24; i++) {
        const x = r.x0 + 120 + rng() * (r.x1 - r.x0 - 240);
        const y = r.y0 + 120 + rng() * (r.y1 - r.y0 - 240);
        if (Math.hypot(x - bank.x, y - bank.y) < PAD_R * 1.6 + 70) continue;
        let nearProt = false;
        for (const p of protectorSpots(team)) if (Math.hypot(x - p.x, y - p.y) < 150) { nearProt = true; break; }
        if (nearProt) continue;
        return { x, y };
    }
    const c = baseCenter(team);
    return { x: c.x + (team === BLUE ? 260 : -260), y: c.y + 260 };
}

function clearZones() {
    const zones = [];
    for (const t of TEAMS) {
        const r = baseRect(t);
        zones.push({ rect: r, pad: 170 });
        const s = sitesFor(t);
        zones.push({ x: s.mouth.x, y: s.mouth.y, r: YARD_R });
        zones.push({ x: s.pad.x, y: s.pad.y, r: PAD_R + 150 });
        zones.push({ x: s.shop.x, y: s.shop.y, r: PAD_R + 150 });
        zones.push({ x: s.eye.x, y: s.eye.y, r: PAD_R + 190 });
        zones.push({ x: s.tail.x, y: s.tail.y, r: PAD_R + 230 });
    }
    for (const p of NEUTRAL_SHOPS) zones.push({ x: p.x, y: p.y, r: PAD_R + 180 });
    zones.push({ x: 0, y: 0, r: 420 });
    return zones;
}

function inClearZone(x, y, zones = clearZones()) {
    for (const z of zones) {
        if (z.rect) { if (inRect(z.rect, x, y, z.pad || 0)) return true; continue; }
        if ((x - z.x) ** 2 + (y - z.y) ** 2 <= z.r * z.r) return true;
    }
    return false;
}

function vaultSites() {
    const out = [{ name: "Center Vault", x: 0, y: 0, team: 0, kind: 'center' }];
    for (const t of TEAMS) {
        const s = sitesFor(t);
        out.push({ name: teamName(t) + " Team Bank", x: s.bank.x, y: s.bank.y, team: t, kind: 'bank' });
        out.push({ name: teamName(t) + " Eye Vault", x: s.eye.x, y: s.eye.y, team: t, kind: 'eye' });
    }
    for (const t of TEAMS) {
        const s = sitesFor(t);
        out.push({ name: "Outpost", x: s.tail.x, y: s.tail.y, team: 0, kind: 'tail', homeTeam: 0 });
    }
    return out.map((v, i) => ({ id: i, r: PAD_R, rainbow: v.team === 0, ...v }));
}

function shopSites() {
    const out = [];
    for (const t of TEAMS) {
        const s = sitesFor(t);
        out.push({ name: teamName(t) + " Team Shop", x: s.shop.x, y: s.shop.y, team: t, color: t === BLUE ? "#2f7ff2" : "#f0405a" });
    }
    NEUTRAL_SHOPS.forEach((p, i) => out.push({ name: i === 0 ? "South Shop" : "North Shop", x: p.x, y: p.y, team: 0, color: "#8a8f9c" }));
    return out.map((s, i) => ({ id: i, r: PAD_R, ...s }));
}

function supplySpots(team) {
    const m = sitesFor(team).mouth;
    const dir = team === BLUE ? 1 : -1;
    return [{ x: m.x + dir * 450, y: m.y - 330 }, { x: m.x + dir * 450, y: m.y + 330 }];
}

function warPads() {
    return TEAMS.map(t => ({ team: t, ...sitesFor(t).pad, r: PAD_R }));
}

module.exports = {
    BLUE, RED, TEAMS, TILE, BASE_TILES, CENTER, DRONE_R, YARD_R, PAD_R, NEUTRAL_SHOPS, LANES,
    mirror, other, teamNo, teamOfNo, teamName, isTeam,
    baseRect, baseCenter, protectorSpots, sitesFor, lane, inRect, inBase, baseAt, inDroneZone, territoryOf,
    baseSpawnSpot, clearZones, inClearZone, vaultSites, shopSites, warPads, supplySpots,
};
