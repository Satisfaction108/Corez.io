function aoWorld() { try { return require('./alwaysOn.js').on(); } catch { return false; } }
// Dig Royale shop pads (four, on the cardinal rays between the Center Vault
// and each base). Paid from banked gems only; state lives on the socket, so it
// survives death and resets with the raid.

// Bulwark: rock from gap past your hull out to r rises at rate x the normal pace (16 s / rate), up to max cells
const BULWARK = { r: 420, gap: 70, rate: 5, max: 36 };
// bought stat points per raid (Oct 7)
const STATPT_MAX = 10;
const PAD_RADIUS = 95;

const DRILL_MULT = [1, 1.25, 1.5, 1.8, 2.15, 2.6];
// Satchel caps (owner, Oct 5 2026): 8,000
const SATCHEL_BASE = 8000;
const SATCHEL_STEP = 4000;

// `retired`: off the shelf while the ability system is on (abilities.js),
// back when ROYALE_ABILITIES=0. Their effects still work for anything that
// already has them (old saves, twists, the tutorial). `fresh`: only sold
// with the ability system on.
const ITEMS = [
    { id: "drill1", cat: "drill", tier: 1, name: "Drill I",   price: 400,  desc: "You mine 25% faster." },
    { id: "drill2", cat: "drill", tier: 2, name: "Drill II",  price: 900,  desc: "You mine 50% faster." },
    { id: "drill3", cat: "drill", tier: 3, name: "Drill III", price: 1600, desc: "You mine 80% faster." },
    { id: "drill4", cat: "drill", tier: 4, name: "Drill IV",  price: 2600, desc: "You mine 115% faster." },
    { id: "drill5", cat: "drill", tier: 5, name: "Drill V",   price: 4000, desc: "You mine 160% faster, and you dig at full speed right after you respawn." },
    // gear: timed (GEAR_MS); `on` is the message shown when it starts
    { id: "statpt",    cat: "gear", name: "Stat Point",         price: 1000, desc: "Gives you one extra stat point that you keep after dying. You can buy up to 10 per raid.", aoDesc: "Gives you one extra stat point that you keep after dying. You can buy up to 10." },
    { id: "scanner",   cat: "gear", name: "Ore Scanner",        price: 1000, desc: "Shows shard and emerald veins within 1.5km on your minimap for 5 minutes.", on: "Veins near you now show on your minimap." },
    { id: "magnet",    cat: "gear", name: "Gem Magnet",         price: 900,  desc: "Pulls in gems from almost twice as far away for 5 minutes.", on: "Gems now come to you from much farther away." },
    { id: "satchel",   cat: "gear", name: "Reinforced Satchel", price: 700,  desc: "You can carry 12,000 gems instead of 8,000 for 5 minutes, or 16,000 with Deep Pockets.", on: "Your satchel holds 4,000 more gems now." },
    { id: "insurance", cat: "gear", name: "Insurance",          price: 1200, desc: "If you die in the next 5 minutes, a quarter of your satchel gets banked instead of dropped.", on: "If you die, a quarter of your satchel gets banked." },
    { id: "cloak",     cat: "gear", name: "Storm Cloak",        price: 1100, retired: true, desc: "The storm only does half damage to you for 5 minutes.", on: "The storm now does half damage to you." },
    { id: "boots",     cat: "gear", name: "Quick Treads",       price: 1300, retired: true, desc: "Move 25% faster for 5 minutes.", on: "You move 25% faster." },
    { id: "plating",   cat: "gear", name: "Armor Plating",      price: 1300, retired: true, desc: "25% more max health for 5 minutes.", on: "You have 25% more max health." },
    { id: "express",   cat: "gear", name: "Vault Express",      price: 600,  retired: true, desc: "Vault deposits go twice as fast for 5 minutes.", on: "Your deposits now go twice as fast." },
    { id: "mark",      cat: "gear", name: "Hunter's Mark",      price: 1800, retired: true, desc: "Each kill is worth an extra 100 points for 5 minutes.", on: "Your kills now pay an extra 100 points." },
    { id: "wind",      cat: "gear", name: "Second Wind",        price: 800,  retired: true, desc: "For 5 minutes your spawn shield holds 10 seconds while you move, so you can get clear after a respawn. Shooting still drops it after 5 seconds.", on: "Your spawn shield now holds while you move for 10 seconds." },
    // kit: consumables, 3 distinct types at a time, used with Z / R / N
    { id: "charge",    cat: "kit", name: "Seismic Charge", price: 350, max: 3, desc: "Throws a charge at your cursor (up to 500m away) that shatters every rock within 150m." },
    { id: "strut",     cat: "kit", name: "Support Strut",  price: 250, max: 3, retired: true, desc: "Props open everything within 320m of you for 3 minutes: nothing grows back there, and rock that is already regrowing crumbles." },
    { id: "medkit",    cat: "kit", name: "Medkit",         price: 300, max: 3, desc: "Heals half your health on the spot and keeps the storm off you for 3 seconds." },
    { id: "rocket",    cat: "kit", name: "Rocket Boots",   price: 300, max: 3, fresh: true, desc: "You move more than twice as fast for 7 seconds." },
    { id: "flare",     cat: "kit", name: "Escape Flare",   price: 450, max: 2, fresh: true, desc: "Blinks you up to 420m toward the nearest vault, straight through rock." },
    { id: "overdrive", cat: "kit", name: "Overdrive Core", price: 450, max: 2, retired: true, desc: "Double mining power and 30% faster reload for 20 seconds." },
    { id: "anchor",    cat: "kit", name: "Storm Anchor",   price: 400, max: 2, desc: "The storm can't hurt you for 15 seconds." },
    { id: "flash",     cat: "kit", name: "Flash Vault",    price: 500, max: 2, desc: "Banks up to 1,000 of the gems you're carrying from wherever you are, minus a 30% fee." },
    { id: "bulwark",   cat: "kit", name: "Bulwark",        price: 300, max: 3, desc: "Quickly regrows the dug-out rock within 420m of you, so you get instant cover." },
    { id: "decoy",     cat: "kit", name: "Decoy Satchel",  price: 250, max: 3, desc: "Makes you look like you're carrying a full satchel for 20 seconds, to lure other players in." },
    { id: "barrage",   cat: "kit", name: "Rock Barrage",   price: 3000, max: 1, desc: "Hurls 10 rock chunks at your cursor, and each one smashes through two rocks on the way. Every hit takes 9% of a tank's health, even through its shield." },
    // sidearms: one mounted at a time, fired with the sidearm key (command bit 128)
    { id: "flak",  cat: "arm", name: "Annihilator", price: 1500, desc: "Fires one huge annihilator shell at your cursor. It has a 7 second reload." },
    { id: "lance", cat: "arm", name: "Drill Lance", price: 1200, desc: "Fires a bolt that shatters any rock it hits. It has a 5 second reload." },
    { id: "pod",   cat: "arm", name: "Swarm Barrels", price: 1800, desc: "Adds two battleship barrels on each side that send seeker drones at your cursor. They burn out after 2.5 minutes." },
    // abilities (abilities.js): owned for the raid, one in the slot at a time
    ...require('./abilities.js').catalog().map(a => Object.assign(a, { fresh: true })),
];
// Every price above, raised by half (Oct 21 2026), to the nearest 50.
// basePrice is the old one: what a save from before paid, and gets back.
const PRICE_MULT = 1.5;
for (const it of ITEMS) { it.basePrice = it.price; it.price = Math.round(it.price * PRICE_MULT / 50) * 50; }
const BY_ID = new Map(ITEMS.map(i => [i.id, i]));

let shops = null;

function getShops() {
    if (!Config.dig_royale && !Config.tutorial) return [];
    if (shops && shops.length) return shops;
    const tg = global.gameManager && global.gameManager.terrainGrid;
    if (!tg || !tg.shopSites || !tg.shopSites.length) return [];
    shops = tg.shopSites.map(s => ({ id: s.id, name: s.name, x: s.x, y: s.y, r: s.r || PAD_RADIUS, color: s.color || "#7fb1f2", kind: 'shop' }));
    return shops;
}

function snapshot() {
    return getShops().map(s => ({ id: s.id, name: s.name, x: s.x, y: s.y, r: s.r, c: s.color }));
}

const abilities = require('./abilities.js');
// What the shelves carry: the ability-era list, or the old one with the
// kill switch (ROYALE_ABILITIES=0).
function offered(item) {
    if (!item) return false;
    return abilities.ON ? !item.retired : !item.fresh;
}
function catalog() {
    const ao = aoWorld();
    return ITEMS.filter(offered).map(i => ({ id: i.id, cat: i.cat, tier: i.tier || 0, name: i.name, price: i.price, max: i.max || 0, desc: ao && i.aoDesc ? i.aoDesc : i.desc, cd: i.cd || 0, place: i.place || 0 }));
}

function freshState() {
    return { drill: 0, gear: {}, kit: {}, kitOrder: [], arm: null, spent: 0, statPts: 0 };
}

// Bought stat points (the Stat Point item) last the raid: every new body
// (a respawn) gets them again, once. -> how many upgrade points are left to
// place on this body (caps minus what's spent minus what's unspent)
function statRoom(body) {
    const sk = body && body.skill;
    if (!sk || !sk.caps) return 0;
    let room = 0;
    for (let i = 0; i < sk.caps.length; i++) room += Math.max(0, (sk.caps[i] | 0) - (sk.raw[i] | 0));
    return room - (sk.points | 0);
}
function applyStatPoints(body, s) {
    if (!body || !body.skill || !s) return;
    const want = s.statPts | 0, have = body._shopStatPts | 0;
    if (want > have) { body.skill.points += want - have; body._shopStatPts = want; }
}

// Kit invariants, re-asserted on every read: no zero counts, counts within
// max, kitOrder is the slots (index 0 = key 1) holding each held id once,
// with null for an empty slot in between (the player can drag an item to
// any slot), no trailing nulls, at most KIT_SLOTS slots.
const KIT_SLOTS = 3;
function normalizeKit(s) {
    if (!s) return s;
    if (!s.kit) s.kit = {};
    if (!Array.isArray(s.kitOrder)) s.kitOrder = [];
    for (const id of Object.keys(s.kit)) {
        const item = BY_ID.get(id);
        if (!item || item.cat !== "kit" || !(s.kit[id] > 0)) { delete s.kit[id]; continue; }
        s.kit[id] = Math.min(item.max || 1, s.kit[id] | 0);
    }
    const order = s.kitOrder.slice(0, KIT_SLOTS).map((id, i, a) => (id && s.kit[id] > 0 && a.indexOf(id) === i) ? id : null);
    for (const id of Object.keys(s.kit)) {
        if (order.includes(id)) continue;
        const free = kitFreeSlot(order);
        if (free < 0) { delete s.kit[id]; continue; }
        order[free] = id;
    }
    while (order.length && !order[order.length - 1]) order.pop();
    s.kitOrder = order;
    return s;
}
// the first empty slot (a hole, or past the end), or -1 when all are full
function kitFreeSlot(order) {
    for (let i = 0; i < KIT_SLOTS; i++) if (!order[i]) return i;
    return -1;
}
function kitCount(order) { let n = 0; for (const id of order || []) if (id) n++; return n; }
// put id in the first empty slot (no-op if it has one already)
function kitPlace(s, id) {
    if (s.kitOrder.includes(id)) return s.kitOrder.indexOf(id);
    const free = kitFreeSlot(s.kitOrder);
    if (free < 0) return -1;
    s.kitOrder[free] = id;
    return free;
}
// a slot emptied: a hole stays where it was (trailing ones go)
function kitEmpty(s, id) {
    const i = s.kitOrder.indexOf(id);
    if (i >= 0) s.kitOrder[i] = null;
    while (s.kitOrder.length && !s.kitOrder[s.kitOrder.length - 1]) s.kitOrder.pop();
}

function stateOf(socket) {
    if (!socket) return null;
    if (!socket.shop) socket.shop = freshState();
    return socket.shop;
}

function resetAll() {
    // abilities first: the raid ledger empties before anyone's state is rebuilt
    abilities.resetRaid();
    const clients = (global.gameManager.socketManager && global.gameManager.socketManager.clients) || [];
    for (const c of clients) {
        if (!c) continue;
        c.shop = freshState();
        const b = c.player && c.player.body;
        if (b && !b.isDead?.()) {
            detachSidearm(b);
            applyPassives(b);
        }
        talkState(c);
        abilities.talkState(c);
    }
}

// `ok`: the message is good news (client picks sound + colour).
function talkState(socket, msg, ok = false) {
    if (!socket || !socket.talk) return;
    const s = normalizeKit(stateOf(socket));
    try {
        socket.talk('SHP', JSON.stringify({
            drill: s.drill, gear: Object.keys(s.gear), gearUntil: s.gear, statPts: s.statPts | 0, kit: s.kit, kitOrder: s.kitOrder, arm: s.arm, armUntil: s.armUntil || 0,
            msg: msg || "", ok: !!(ok && msg),
        }));
    } catch { /* */ }
}

function bankedOf(socket) { return (socket && socket.gemBanked) | 0; }

// ── effect queries (players only; bots get 1x) ──────────────────────────
function shopOf(body) { return body && body.socket ? stateOf(body.socket) : null; }

function miningMult(body) {
    const s = shopOf(body);
    if (!s) return 1;
    return DRILL_MULT[Math.max(0, Math.min(5, s.drill | 0))] || 1;
}
// Gear is timed: s.gear[id] holds its expiry (true = permanent, tutorial).
function gearActive(s, id) { const t = s && s.gear[id]; return !!t && (t === true || Date.now() < t); }
// bots have no shop state: a twist's free gear sits on the body instead
function hasGear(body, id) {
    if (gearActive(shopOf(body), id)) return true;
    return !!(body && !body.socket && body._twistGear && body._twistGear.includes(id));
}
// raid perks (raidPerks.js) ride on top: Ore Magnet, Deep Pockets
function magnetMult(body) { return (hasGear(body, "magnet") ? 1.9 : 1) * ((body && body._pkfx && body._pkfx.magnet) || 1); }
function deepPockets(body) {
    return !!(global.royaleMods && global.royaleMods.satchelDeep) || ((body && body._pkfx && body._pkfx.satchel) | 0) > 0;
}
function satchelCap(body) {
    const pkStacks = Math.max(0, (body && body._pkfx && body._pkfx.satchel) | 0);
    const deepBonus = pkStacks > 0 ? pkStacks * SATCHEL_STEP : (deepPockets(body) ? SATCHEL_STEP : 0);
    return SATCHEL_BASE + (hasGear(body, "satchel") ? SATCHEL_STEP : 0) + deepBonus;
}
function depositRateMult(body) { return hasGear(body, "express") ? 2 : 1; }
function stormDamageMult(body) {
    if (body && body.stormAnchorUntil && Date.now() < body.stormAnchorUntil) return 0;
    const ward = (body && body._pkfx && body._pkfx.stormward) || 1;
    return (hasGear(body, "cloak") ? 0.5 : 1) * ward;
}
const WIND_SHIELD_MS = 10000;
function spawnMoveShieldMs(body) { return hasGear(body, "wind") ? WIND_SHIELD_MS : 0; }
function killBonus(body) { return hasGear(body, "mark") ? 100 : 0; }
function keepsDrillOnRespawn(body) { const s = shopOf(body); return !!(s && s.drill >= 5); }

function applyPassives(body) {
    if (!body) return;
    const s = shopOf(body);
    const pk = body._pkfx;
    const surge = (pk && pk.surge > 0 && body._pkSurgeUntil && Date.now() < body._pkSurgeUntil) ? (1 + pk.surge) : 1;
    body.bonusSpeedMult = (hasGear(body, "boots") ? 1.25 : 1) * abilities.speedMult(body) * ((pk && pk.speed) || 1) * surge;
    body.bonusHealthMult = (hasGear(body, "plating") ? 1.25 : 1) * ((pk && pk.health) || 1);
    body.bonusShieldMult = (pk && pk.aegis) || 1;
    body.gemCap = satchelCap(body);
    applyStatPoints(body, s);
    try { body.refreshBodyAttributes(); } catch { /* */ }
    const arm = armOf(body);
    if (arm) attachSidearm(body, arm);
}

// ── sidearms ───────────────────────────────────────────────────────────
// The sidearm this body should carry: the shop state's for a player, the
// twist's for a bot (bots have no shop state).
function armOf(body) {
    const s = shopOf(body);
    if (s) return s.arm || null;
    return (body && body._twistArm) || null;
}
const POD_LAYOUTS = [[90, 270], [135, 225], [45, 315], [160, 200]];
function podAngles(body) {
    const taken = [];
    if (body && body.guns) {
        for (const gun of body.guns.values()) {
            if (!gun || gun.isSidearm || gun.isRaidPerk || gun.hidden) continue;
            taken.push(((gun.angle * 180 / Math.PI) % 360 + 360) % 360);
        }
    }
    const gap = (a, b) => { const d = Math.abs(a - b) % 360; return Math.min(d, 360 - d); };
    for (const layout of POD_LAYOUTS) if (layout.every(a => taken.every(t => gap(a, t) >= 30))) return layout;
    return POD_LAYOUTS[0];
}
function sidearmDef(id, body) {
    const { combineStats } = require('../../lib/definitions/facilitators.js');
    const g = require('../../lib/definitions/gunvals.js');
    // hidden guns: the shot appears at the hull and flies at the cursor
    // (reload 3.8 is about 5 s)
    if (id === "flak") return {
        POSITION: [18, 20, 1, 0, 0, 0, 0],
        PROPERTIES: {
            SHOOT_SETTINGS: combineStats([g.basic, g.pounder, g.destroyer, g.annihilator, { reload: 5.3, damage: 1.6, health: 1.6, size: 1.2 }]),
            TYPE: "bullet", ALT_FIRE: true, LABEL: "Annihilator", COLOR: "mirror", HIDDEN: true,
        },
    };
    if (id === "lance") return {
        POSITION: [19, 6, 1, 0, 0, 0, 0],
        PROPERTIES: {
            SHOOT_SETTINGS: combineStats([g.basic, g.sniper, { reload: 3.8, speed: 1.4, maxSpeed: 1.4, damage: 0.6, health: 2.5, pen: 2.5 }]),
            TYPE: "bullet", ALT_FIRE: true, LABEL: "Drill Lance", COLOR: "mirror", HIDDEN: true, ROCK_POWER: 1000,
        },
    };
    // Two battleship barrels a side. Gun X/Y are in the gun's rotated frame
    // (offset is rotated by direction + angle), so for a sideways gun X is the
    // distance out on the flank and Y is fore/aft.
    if (id === "pod") {
        const [a1, a2] = podAngles(body);
        return [[7, -4.5, a1, 0], [7, 4.5, a1, 0.5], [7, 4.5, a2, 0.25], [7, -4.5, a2, 0.75]].map(([x, y, ang, delay]) => ({
            POSITION: [9, 7, 0.7, x, y, ang, delay],
            PROPERTIES: {
                SHOOT_SETTINGS: combineStats([g.swarm, g.battleship, { reload: 1.15, damage: 1.15, health: 1.1 }]),
                TYPE: "swarm", ALT_FIRE: true, LABEL: "Swarm Barrel", COLOR: 16,
                STAT_CALCULATOR: "swarm", MAX_CHILDREN: 40,
            },
        }));
    }
    return null;
}

function detachSidearm(body) {
    if (!body || (!body.sidearmGun && !(body.sidearmGuns && body.sidearmGuns.length))) return;
    const guns = body.sidearmGuns && body.sidearmGuns.length ? body.sidearmGuns : [body.sidearmGun];
    body.sidearmGun = null;
    body.sidearmGuns = null;
    body.sidearmId = null;
    for (const gun of guns) {
        if (!gun) continue;
        try {
            for (const child of [...gun.children, ...gun.bulletchildren]) {
                if (child && !child.isGhost) { try { child.kill(); } catch { /* */ } }
            }
            body.guns.delete(gun.id);
            const i = body.gunsArrayed.indexOf(gun);
            if (i >= 0) body.gunsArrayed.splice(i, 1);
        } catch { /* */ }
    }
    body.photo = undefined;
}

function attachSidearm(body, id) {
    if (!body || body.isDead?.()) return false;
    const def = sidearmDef(id, body);
    if (!def) return false;
    if (body.sidearmGun && body.guns.get(body.sidearmGun.id) === body.sidearmGun && body.sidearmId === id) return true;
    detachSidearm(body);
    const defs = Array.isArray(def) ? def : [def];
    const guns = [];
    try {
        for (const d of defs) {
            const gun = new Gun(body, d);
            gun.isSidearm = true;
            body.guns.set(gun.id, gun);
            body.gunsArrayed.push(gun);
            gun.syncChildren && gun.syncChildren();
            guns.push(gun);
        }
        body.sidearmGuns = guns;
        body.sidearmGun = guns[0];
        body.sidearmId = id;
        body.photo = undefined;
    } catch (e) {
        for (const gun of guns) { try { body.guns.delete(gun.id); const i = body.gunsArrayed.indexOf(gun); if (i >= 0) body.gunsArrayed.splice(i, 1); } catch { /* */ } }
        body.sidearmGun = null; body.sidearmGuns = null;
        body.sidearmId = null;
        return false;
    }
    // class changes rebuild the gun list: put the sidearm back
    if (!body._sidearmHooked) {
        body._sidearmHooked = true;
        body.on('define', () => {
            if (!armOf(body)) return;
            if (body.sidearmGun && body.guns.get(body.sidearmGun.id) === body.sidearmGun) return;
            body.sidearmGun = null;
            setImmediate(() => { try { const arm = armOf(body); if (arm && !body.isDead?.()) attachSidearm(body, arm); } catch { /* */ } });
        });
    }
    return true;
}

// Twist sidearm grant: no burn-out when permanent. Pass the body when you
// have it: during a spawn socket.player is still the last life's player
// (sockets.spawn assigns it after the join hooks run), so its body is the
// dead one or nothing. The state is set either way, and applyPassives on
// the next spawn mounts it.
function grantArm(socket, id, permanent = true, body = null) {
    const s = stateOf(socket);
    if (!s || !sidearmDef(id)) return false;
    s.arm = id;
    s.armUntil = permanent ? 0 : Date.now() + ARM_BURN_MS;
    const b = body || (socket.player && socket.player.body);
    if (b && !b.isDead?.()) attachSidearm(b, id);
    return true;
}

// ── purchases ──────────────────────────────────────────────────────────
function canBuy(socket, item) {
    const s = normalizeKit(stateOf(socket));
    if (!s || !item) return { ok: false, why: "Unknown item." };
    if (!offered(item)) return { ok: false, why: "That isn't sold any more." };
    if (item.cat === "ability") {
        const a = abilities.canBuy(socket, item);
        if (!a.ok) return a;
        if (a.equip) return { ok: true, equip: true };
    } else if (item.cat === "drill") {
        if (s.drill >= item.tier) return { ok: false, why: "You already own that." };
        if (item.tier !== s.drill + 1) return { ok: false, why: "Buy Drill " + ["I", "II", "III", "IV", "V"][s.drill] + " first." };
    } else if (item.id === "statpt") {
        const body = socket.player && socket.player.body;
        if ((s.statPts | 0) >= STATPT_MAX) return { ok: false, why: (aoWorld() ? "That's the most stat points you can buy (" : "That's the most stat points you can buy this raid (") + STATPT_MAX + ")." };
        if (!body || statRoom(body) <= 0) return { ok: false, why: "Every stat is already maxed out, so there's nowhere to put another point." };
    } else if (item.cat === "gear") {
        if (gearActive(s, item.id)) return { ok: false, why: "That one is already running." };
        if (Object.keys(s.gear).filter(id => gearActive(s, id)).length >= GEAR_MAX) return { ok: false, why: "You can only have " + GEAR_MAX + " gear items running at once." };
    } else if (item.cat === "kit") {
        const have = s.kit[item.id] | 0;
        if (have >= (item.max || 1)) return { ok: false, why: "You're already carrying as many of those as you can." };
        if (!have && kitCount(s.kitOrder) >= KIT_SLOTS) return { ok: false, why: "Your kit is full. It can hold 3 kinds of items." };
    } else if (item.cat === "arm") {
        if (s.arm === item.id) return { ok: false, why: "You already have that one mounted." };
    }
    if (bankedOf(socket) < item.price) return { ok: false, why: "You don't have enough banked gems." };
    return { ok: true };
}

function buy(socket, itemId) {
    const body = socket && socket.player && socket.player.body;
    if (!body || body.isDead?.()) return false;
    if (!body.shopOnPad) { talkState(socket, "You need to be standing on a shop pad."); return false; }
    const item = BY_ID.get(String(itemId));
    const chk = canBuy(socket, item);
    if (!chk.ok) { talkState(socket, chk.why); return false; }
    const s = stateOf(socket);
    // an ability you already own: swapping it in is free
    if (chk.equip) {
        abilities.equip(socket, item.id);
        talkState(socket, item.name + " equipped.", true);
        abilities.talkState(socket);
        return true;
    }
    const gems = require('./gems.js');
    gems.setBanked(body, bankedOf(socket) - item.price);
    s.spent += item.price;
    let msg = "Bought " + item.name + ".";
    if (item.cat === "drill") s.drill = item.tier;
    else if (item.id === "statpt") {
        s.statPts = (s.statPts | 0) + 1;
        applyStatPoints(body, s);
        msg = aoWorld() ? "You got an extra stat point! Spend it on any stat, and it's yours for as long as you play." : "You got an extra stat point! Spend it on any stat, and it's yours for the rest of the raid.";
    }
    else if (item.cat === "gear") {
        s.gear[item.id] = Date.now() + GEAR_MS;
        applyPassives(body);
        msg = item.name + " is running for the next 5 minutes. " + (item.on || "");
    }
    else if (item.cat === "kit") {
        s.kit[item.id] = (s.kit[item.id] | 0) + 1;
        const slot = kitPlace(s, item.id);
        msg = item.name + " is in kit slot " + (slot + 1) + ".";
    } else if (item.cat === "arm") {
        s.arm = item.id;
        s.armUntil = item.id === "pod" ? Date.now() + ARM_BURN_MS : 0;
        // a bought arm replaces a twist's free one, so the twist ending must
        // not take it away
        s._twistArm = null;
        s._paidArm = null;
        attachSidearm(body, item.id);
        msg = item.name + " is mounted. Fire it with the sidearm key.";
    } else if (item.cat === "ability") {
        abilities.grant(socket, item.id);
        msg = item.name + (aoWorld() ? " is yours for as long as you play. It's in your ability slot." : " is yours for the raid. It's in your ability slot.");
    }
    body._shopLastBuyAt = Date.now();
    body._shopBought = true;
    try { gems.talkGems(body, 0); } catch { /* */ }
    if (Config.dig_royale) try { require('../gamemodes/scripts/dig_royale.js').onShopBuy(body, item); } catch { /* */ }
    talkState(socket, msg, true);
    if (item.cat === "ability") abilities.talkState(socket);
    return true;
}

// Chest and boss drops hand out kit items without a pad. Returns false when
// the kit is full so the caller can pay gems instead.
function grantKit(socket, itemId, count = 1) {
    const s = normalizeKit(stateOf(socket));
    const item = BY_ID.get(itemId);
    if (!s || !item || item.cat !== "kit") return false;
    const have = s.kit[item.id] | 0;
    if (!have && kitCount(s.kitOrder) >= KIT_SLOTS) { talkState(socket, "Your kit is full. It can hold 3 kinds of items."); return false; }
    if (have >= (item.max || 1)) { talkState(socket, "Your " + item.name + " stack is full."); return false; }
    s.kit[item.id] = Math.min(item.max || 1, have + count);
    kitPlace(s, item.id);
    talkState(socket, "Found " + item.name + ".", true);
    return true;
}

function randomKitId() {
    const pool = ITEMS.filter(i => i.cat === "kit" && i.id !== "barrage" && offered(i)).map(i => i.id);
    return pool[(Math.random() * pool.length) | 0];
}

// ── Rock Barrage ───────────────────────────────────────────────────────
// Rock chunks fan out toward the cursor. They are noclip entities moved by
// hand here, so engine collision never touches them and damage is exactly
// hitFrac of max health per chunk, through the shield. Each chunk smashes
// `pierce` rocks, and dies on the next, on a vault pad, or at end of range.
const STRUT_RADIUS = 320;
const BARRAGE = { count: 10, speed: 30, range: 950, spread: 0.26, hitFrac: 0.09, bossFrac: 0.015, pierce: 2, radius: 14 };
const barrageShards = [];

function launchBarrage(body, tx, ty) {
    let dx = (+tx || 0) - body.x, dy = (+ty || 0) - body.y;
    if (!(Math.hypot(dx, dy) > 1)) { dx = Math.cos(body.facing || 0); dy = Math.sin(body.facing || 0); }
    const base = Math.atan2(dy, dx);
    const now = Date.now();
    for (let i = 0; i < BARRAGE.count; i++) {
        // even fan with a little scatter and staggered speeds
        const t = BARRAGE.count > 1 ? i / (BARRAGE.count - 1) - 0.5 : 0;
        const a = base + t * BARRAGE.spread * 2 + (Math.random() - 0.5) * 0.06;
        const sp = BARRAGE.speed * (0.85 + Math.random() * 0.3);
        const start = (body.realSize || 30) + 10;
        let o;
        try {
            o = new Entity({ x: body.x + Math.cos(a) * start, y: body.y + Math.sin(a) * start }, body);
            o.define('rockBarrageShard');
            o.team = body.team;
            o.source = body;
            o.noclip = true;
            o.settings.diesAtRange = false;
            o.alwaysActive = true;
            o.refreshBodyAttributes();
            o.damage = 1;      // killer credit reads instance.damage
            o.velocity.x = 0; o.velocity.y = 0;
        } catch (e) { continue; }
        barrageShards.push({ e: o, owner: body, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, left: BARRAGE.range, pierce: BARRAGE.pierce, at: now });
    }
}

function barrageTargets(owner) {
    const out = [];
    for (const e of entities.values()) {
        if (!e || e === owner || e.isDead?.()) continue;
        if (!(e.isPlayer || e.isBot || e.isRoyaleBoss)) continue;
        if (e.team === owner.team) continue;
        if (e.invuln || e.godmode || e.passive || e.padSafe || e.royaleLobby) continue;
        out.push(e);
    }
    return out;
}

function hitWithRock(target, shard, owner) {
    const frac = target.isRoyaleBoss ? BARRAGE.bossFrac : BARRAGE.hitFrac;
    const dmg = (target.health.max || 0) * frac;
    if (!(dmg > 0)) return;
    target.health.amount -= dmg;
    target.hitAt = Date.now();
    try { target.reportDamageNumber && target.reportDamageNumber(dmg); } catch { /* */ }
    // Kill credit: the next mortality check reads collisionArray before it is
    // cleared; a sliver of damageReceived raises the usual damage event.
    target.collisionArray.push(shard.e);
    target.damageReceived = (target.damageReceived || 0) + 1e-6;
    target._lastDamageSource = owner;
    target._lastDamageAt = Date.now();
}

function tickBarrage() {
    if (!barrageShards.length) return;
    const tg = global.gameManager && global.gameManager.terrainGrid;
    const now = Date.now();
    const vaults = (() => { try { return Config.dig_royale ? require('./vault.js').getVaults() : []; } catch { return []; } })();
    const gems = require('./gems.js');
    const targetsByOwner = new Map();
    for (let i = barrageShards.length - 1; i >= 0; i--) {
        const s = barrageShards[i];
        const e = s.e;
        const dt = Math.min(3, Math.max(0.2, (now - s.at) / 33.3));
        s.at = now;
        let dead = !e || e.isDead?.() || !s.owner || s.left <= 0;
        if (!dead) {
            // sub-steps so a fast chunk cannot skip over a small tank or rock
            const steps = Math.max(1, Math.ceil(Math.hypot(s.vx, s.vy) * dt / BARRAGE.radius));
            const sx = s.vx * dt / steps, sy = s.vy * dt / steps;
            let targets = targetsByOwner.get(s.owner);
            if (!targets) { targets = barrageTargets(s.owner); targetsByOwner.set(s.owner, targets); }
            for (let k = 0; k < steps && !dead; k++) {
                e.x += sx; e.y += sy;
                s.left -= Math.hypot(sx, sy);
                for (const t of targets) {
                    if (t.isDead?.()) continue;
                    const r = BARRAGE.radius + (t.realSize || t.size || 30);
                    if ((t.x - e.x) ** 2 + (t.y - e.y) ** 2 > r * r) continue;
                    hitWithRock(t, s, s.owner);
                    dead = true;
                    break;
                }
                if (dead) break;
                for (const v of vaults) {
                    if (require('./vault.js').onPadShape(v, e.x - v.x, e.y - v.y, 8)) { dead = true; break; }
                }
                if (dead || !tg) break;
                const rock = tg.rockHitByCircle(e.x, e.y, BARRAGE.radius)
                    || (tg.growingRockHitByCircle ? tg.growingRockHitByCircle(e.x, e.y, BARRAGE.radius, now) : null);
                if (rock) {
                    const wasGrowing = rock.growing;
                    const rx = rock.worldCx || rock.wx, ry = rock.worldCy || rock.wy;
                    if (tg.damageRock(rock, rock.health + 1, e.x, e.y, false, s.owner)) {
                        s.owner.rocksMined = (s.owner.rocksMined || 0) + 1;
                        if (!wasGrowing && rock.ore) { s.owner.gemsMined = (s.owner.gemsMined || 0) + 1; try { gems.spawnOreBurst(rock, s.owner); } catch { /* */ } }
                    }
                    if (--s.pierce <= 0) dead = true;
                }
                if (s.left <= 0) dead = true;
            }
            e.velocity.x = 0; e.velocity.y = 0; e.accel.x = 0; e.accel.y = 0;
        }
        if (dead) {
            try { if (e && !e.isDead?.()) { e.kill(); } } catch { /* */ }
            barrageShards.splice(i, 1);
        }
    }
}

// ── kit usage ──────────────────────────────────────────────────────────
// Discards the whole stack in a slot. No refund.
function dropKit(socket, slot) {
    const body = socket && socket.player && socket.player.body;
    const s = normalizeKit(stateOf(socket));
    if (!body || !s) return false;
    const id = s.kitOrder[slot | 0];
    if (!id) return false;
    const item = BY_ID.get(id);
    delete s.kit[id];
    kitEmpty(s, id);
    talkState(socket, "You dropped the " + (item ? item.name : "item") + ".");
    return true;
}

// Kit slots rearranged by drag and drop: the item in `from` trades places
// with whatever is in `to`, an empty slot included (it stays there). The
// keys follow the slot.
function swapKit(socket, from, to) {
    const s = normalizeKit(stateOf(socket));
    if (!s || !Number.isInteger(from) || !Number.isInteger(to)) return false;
    if (from < 0 || to < 0 || from >= KIT_SLOTS || to >= KIT_SLOTS || from === to) return false;
    const id = s.kitOrder[from];
    if (!id) return false;
    while (s.kitOrder.length < KIT_SLOTS) s.kitOrder.push(null);
    s.kitOrder[from] = s.kitOrder[to] || null;
    s.kitOrder[to] = id;
    normalizeKit(s);
    talkState(socket);
    return true;
}

// Bulwark (Oct 7: a wider ring to BULWARK.r, more rock, a quick rise; rock
// already rising on its own speeds up too, it used to be skipped) -> cells raised
function bulwarkRaise(tg, body, now) {
    const B = BULWARK, inner = (body.realSize || 30) + B.gap;
    let n = 0;
    for (const rock of tg.rocks.values()) {
        if (!rock || rock.alive || rock.canyon || !rock.worldPoly) continue;
        const rx = rock.worldCx || rock.wx, ry = rock.worldCy || rock.wy;
        const d2 = (rx - body.x) ** 2 + (ry - body.y) ** 2;
        if (d2 > B.r * B.r || d2 < inner * inner) continue;
        if (rock.growing) {
            if (rock.growFast && rock.growRate >= B.rate) continue;
            rock.growFast = true;
            try { if (tg._setRiseRate(rock, now, B.rate)) n++; } catch { /* */ }
        } else {
            rock.noRegrowUntil = 0;
            try { if (tg.startRegrow(rock, now + n * 25, 0, { fast: true, rate: B.rate }) !== false) n++; } catch { /* */ }
        }
        if (n >= B.max) break;
    }
    return n;
}
function useKit(socket, slot, tx, ty, itemId) {
    const body = socket && socket.player && socket.player.body;
    const s = normalizeKit(stateOf(socket));
    if (!body || body.isDead?.() || !s) return false;
    let id = s.kitOrder[slot | 0];
    // the client names the item it pressed, so a slot that compacted since
    // never fires a different item
    if (itemId && id !== itemId) {
        const i = s.kitOrder.indexOf(itemId);
        if (i < 0) { talkState(socket, "That item is gone."); return false; }
        id = itemId;
    }
    if (!id || !(s.kit[id] > 0)) { talkState(socket, "There's nothing in that slot."); return false; }
    const now = Date.now();
    if (now < (body._kitCdUntil || 0)) return false;
    const tg = global.gameManager.terrainGrid;
    let used = false, msg = "";
    switch (id) {
        case "charge": {
            if (!tg) break;
            let dx = (tx | 0) - body.x, dy = (ty | 0) - body.y;
            const d = Math.hypot(dx, dy) || 1;
            const reach = Math.min(500, d);
            const cx = body.x + dx / d * reach, cy = body.y + dy / d * reach;
            let broke = 0;
            const gems = require('./gems.js');
            for (const rock of tg.rocks.values()) {
                if (!rock || (!rock.alive && !rock.growing) || rock.canyon) continue;
                const rx = rock.worldCx || rock.wx, ry = rock.worldCy || rock.wy;
                if ((rx - cx) * (rx - cx) + (ry - cy) * (ry - cy) > 150 * 150) continue;
                const wasGrowing = rock.growing;
                const destroyed = tg.damageRock(rock, rock.health + 1, rx, ry, false, body);
                if (destroyed) {
                    broke++;
                    body.rocksMined = (body.rocksMined || 0) + 1;
                    if (!wasGrowing && rock.ore) { body.gemsMined = (body.gemsMined || 0) + 1; gems.spawnOreBurst(rock, body); }
                }
            }
            used = true;
            msg = broke ? ("Your Seismic Charge shattered " + broke + " rocks.") : "Your Seismic Charge went off on open ground and hit nothing.";
            if (Config.dig_royale) try { require('../gamemodes/scripts/dig_royale.js').fxAt(cx, cy, "charge"); } catch { /* */ }
            break;
        }
        case "strut": {
            if (!tg) break;
            // A zone, not a list of rocks: anything that dies inside it later
            // stays open too, and rock already mid-regrow crumbles now.
            const R = STRUT_RADIUS;
            tg.addNoRegrowZone(body.x, body.y, R, now + 180_000);
            let crumbled = 0;
            for (const rock of tg.rocks.values()) {
                if (!rock || rock.canyon || !rock.growing) continue;
                const rx = rock.worldCx || rock.wx, ry = rock.worldCy || rock.wy;
                if ((rx - body.x) ** 2 + (ry - body.y) ** 2 > R * R) continue;
                if (tg.damageRock(rock, rock.health + 1, rx, ry, false, null)) crumbled++;
            }
            used = true;
            msg = "Strut placed. Nothing grows back within " + R + " of here for 3 minutes" + (crumbled ? ", and " + crumbled + " regrowing rocks crumbled." : ".");
            break;
        }
        case "barrage": {
            if (!tg) break;
            launchBarrage(body, tx, ty);
            used = true;
            msg = "Rock Barrage launched!";
            break;
        }
        case "medkit": {
            if (!body.health || body.health.amount >= body.health.max * 0.995) { msg = "You're already at full health."; break; }
            body.health.amount = Math.min(body.health.max, body.health.amount + body.health.max * 0.5);
            // 3 s of storm immunity so the heal isn't erased inside the storm
            body.stormAnchorUntil = Math.max(body.stormAnchorUntil || 0, now + 3000);
            used = true;
            msg = "You got half your health back, and the storm can't hurt you for 3 seconds.";
            break;
        }
        case "overdrive": {
            body.overdriveUntil = now + 20_000;
            used = true;
            msg = "Overdrive running. Double mining for 20 seconds.";
            break;
        }
        case "anchor": {
            body.stormAnchorUntil = now + 15_000;
            used = true;
            msg = "Your Storm Anchor is down, so the storm can't hurt you for 15 seconds.";
            break;
        }
        case "flash": {
            const carried = body.carriedGems | 0;
            if (carried < 15) { msg = "You don't have enough gems in your satchel to bank."; break; }
            const take = Math.min(1000, carried);
            const credit = Math.floor(take * 0.7);
            const gems = require('./gems.js');
            body.carriedGems = carried - take;
            // its share of the gemdust banks at the flash vault's 70%
            if (Config.dig_royale) {
                try {
                    const dh = require('../../accounts/game/dustHooks.js');
                    dh.onSatchelOut(body, take, carried, 0.7);
                    dh.onBankDone(body);
                } catch { /* */ }
            }
            gems.setBanked(body, bankedOf(socket) + credit);
            try { gems.updateSatchel(body); gems.talkGems(body, 0); } catch { /* */ }
            if (Config.dig_royale) try { require('../gamemodes/scripts/dig_royale.js').onBanked(body, credit); } catch { /* */ }
            try { require('./milestones.js').checkBanked(body, credit); } catch { /* */ }
            used = true;
            if (global.royaleAch) global.royaleAch.onFlash(body);
            msg = "Flash Vault banked " + credit + " gems.";
            break;
        }
        case "bulwark": {
            if (!tg) break;
            const n = bulwarkRaise(tg, body, now);
            used = n > 0;
            msg = used ? "The rock grows back up around you." : "There's no dug-out rock nearby to regrow.";
            break;
        }
        case "rocket": {
            abilities.rocketBoots(body);
            used = true;
            msg = "Your Rocket Boots are on for " + Math.round(abilities.ROCKET.ms / 1000) + " seconds!";
            break;
        }
        case "flare": {
            used = abilities.escapeFlare(body);
            msg = used ? "You blinked toward the nearest vault!" : "There's no open ground to land on in that direction.";
            break;
        }
        case "decoy": {
            body.decoyUntil = now + 20_000;
            try { require('./gems.js').updateSatchel(body); } catch { /* */ }
            used = true;
            msg = "Your decoy is up, so you look fully loaded for 20 seconds.";
            break;
        }
    }
    if (used) {
        body._kitCdUntil = now + 600;
        try { abilities.kitFx(id, body, tx, ty); } catch { /* */ }
        // every use has a look: the client keys the effect off the item id
        if (Config.dig_royale) try { require('../gamemodes/scripts/dig_royale.js').fxAt(body.x, body.y, "kit_" + id); } catch { /* */ }
        else if (socket) { try { socket.talk('FX', Math.round(body.x), Math.round(body.y), "kit_" + id); } catch { /* */ } }
        s.kit[id] = (s.kit[id] | 0) - 1;
        if (s.kit[id] <= 0) {
            delete s.kit[id];
            kitEmpty(s, id);
        }
    }
    talkState(socket, msg, used);
    return used;
}

// ── death ──────────────────────────────────────────────────────────────
function onDeath(body) {
    const s = shopOf(body);
    if (!s) return { drillLost: 0 };
    if (body.socket) talkState(body.socket, "");
    return { drillLost: 0 };
}

// ── pad tick ───────────────────────────────────────────────────────────
function actorBody(actor) { return actor && actor.body ? actor.body : actor; }

// The pad is drawn as a flat-top hexagon at 1.16x the pad radius; collide
// with that shape (padGeom.js).
const padGeom = require('./padGeom.js');
const HEX_SCALE = padGeom.HEX.scale;
function insideHexagon(dx, dy, R) { return padGeom.insideNgon(dx, dy, R, 6); }
const shopKey = (pad) => 'shop:' + pad.id;
const SHOP_IDLE_MS = 60_000;      // browse time before the shop closes on you
const SHOP_LOCK_MS = 20_000;      // one visit per purchase
const ARM_BURN_MS = 150_000;      // swarm barrels burn out after 2.5 minutes
const GEAR_MS = 300_000;          // every gear item runs for 5 minutes
const GEAR_MAX = 4;               // max gear running at once
function shopEject(body, pad, msg, lockMs) {
    body._shopExpel = pad;                // a steady shove until the hull is clear
    padGeom.keepOut(body, pad, 4, shopKey(pad), 'expel');
    body._shopReentryUntil = Date.now() + lockMs;
    body._shopReentryPad = pad;
    if (msg) { try { body.sendMessage(msg + " You can come back in " + Math.round(lockMs / 1000) + " seconds."); } catch { /* */ } }
}
// One shopper per pad, bots are kept off, and nobody on it can shoot or be
// shot (padSafe, set in the loader). Stand on it to browse, step off to close.
function tick(actors) {
    tickBarrage();
    const list = getShops();
    if (!list.length) return;
    const now = Date.now();
    for (const s of list) s._onPad = [];
    // pass 1: bots are shoved off any pad; humans are listed per pad
    for (const actor of actors) {
        const body = actorBody(actor);
        if (!body || body.isGhost || body.isDead?.()) continue;
        // timed sidearms burn out; timed gear wears off
        if (body.socket) {
            const st = stateOf(body.socket);
            if (st && st.arm && st.armUntil && now > st.armUntil) {
                detachSidearm(body);
                st.arm = null; st.armUntil = 0;
                talkState(body.socket, "Your swarm barrels have burned out.");
            }
            if (st) {
                for (const id of Object.keys(st.gear)) {
                    const until = st.gear[id];
                    if (until === true || now < until) continue;
                    delete st.gear[id];
                    applyPassives(body);
                    const it = BY_ID.get(id);
                    talkState(body.socket, "Your " + (it ? it.name : "gear") + " has worn off.");
                }
            }
        }
        if (!body.socket) {
            for (const s of list) {
                if (padGeom.insidePad(s, body.x, body.y, (body.realSize || 60) * 0.5)) { padGeom.keepOut(body, s, 6, shopKey(s)); break; }
            }
            continue;
        }
        for (const s of list) if (padGeom.insidePad(s, body.x, body.y, 0)) { s._onPad.push(body); break; }
    }
    // pass 2: one shopper per pad
    for (const s of list) {
        const on = s._onPad;
        const keep = (s._occupant && on.includes(s._occupant)) ? s._occupant : (on[0] || null);
        s._occupant = keep;
        for (const body of on) {
            if (body === keep) continue;
            shopEject(body, s, "Someone else is using this shop, so wait your turn.", 3000);
        }
    }
    // pass 3: the shopper's clock and the client panel
    for (const actor of actors) {
        const body = actorBody(actor);
        if (!body || body.isGhost || !body.socket) continue;
        if (body.isDead()) {
            if (body.shopOnPad) body.socket.talk('SHU', 0, -1, "");
            body.shopOnPad = false; body._shopSince = 0; body._shopBought = false; body._shopExpel = null;
            continue;
        }
        const was = !!body.shopOnPad;
        if (body._shopReentryUntil && now < body._shopReentryUntil && body._shopReentryPad) {
            const rp = body._shopReentryPad;
            if (body._shopExpel === rp) { if (padGeom.keepOut(body, rp, 4, shopKey(rp), 'expel')) body._shopExpel = null; }
            else padGeom.keepOut(body, rp, 4, shopKey(rp), true);
            // the wait is for that one shop: any other pad still opens
            if (!list.some(s => s !== rp && s._occupant === body)) {
                if (was && body._shopPad === rp) { body.shopOnPad = false; body.socket.talk('SHU', 0, -1, ""); }
                continue;
            }
        }
        let pad = null;
        for (const s of list) if (s._occupant === body) { pad = s; break; }
        let on = !!pad;
        // a new visit (or straight on to another shop): fresh browse clock
        if (on && (!was || body._shopPad !== pad)) { body._shopSince = now; body._shopBought = false; }
        if (on) {
            // the browse clock only counts idle time
            const busyAt = Math.max(body._shopSince || now, body._shopLastBuyAt || 0);
            // no browse clock in the tutorial: the lesson waits for the purchase
            if (!Config.tutorial && now - busyAt > SHOP_IDLE_MS) {
                shopEject(body, pad, "You browsed for a while, so the shop closed.", 10_000);
                on = false;
            }
        } else if (was && body._shopBought && body._shopPad && !Config.tutorial) {
            // walked off after buying: one visit per purchase (not in the
            // tutorial, whose lessons make two purchases on one pad)
            shopEject(body, body._shopPad, "Thanks for shopping!", SHOP_LOCK_MS);
        }
        if (on) body._shopPad = pad;
        body.shopOnPad = on;
        if (was !== on || (on && body._shopPadSent !== pad)) body.socket.talk('SHU', on ? 1 : 0, on ? pad.id : -1, on ? pad.name : "");
        body._shopPadSent = on ? pad : null;
    }
}

module.exports = {
    ITEMS, BY_ID, getShops, snapshot, catalog, stateOf, freshState, resetAll, talkState, dropKit,
    miningMult, hasGear, magnetMult, satchelCap, deepPockets, SATCHEL_BASE, SATCHEL_STEP, depositRateMult, stormDamageMult, spawnMoveShieldMs, WIND_SHIELD_MS, killBonus,
    BULWARK, bulwarkRaise, STATPT_MAX, keepsDrillOnRespawn, applyPassives, armOf, attachSidearm, detachSidearm, buy, grantKit, grantArm, randomKitId, useKit, swapKit, onDeath, tick,
    KIT_SLOTS, kitCount, kitFreeSlot,
    PAD_RADIUS, DRILL_MULT, insideHexagon, HEX_SCALE, launchBarrage, BARRAGE, STRUT_RADIUS, gearActive, GEAR_MAX,
    offered,
};
