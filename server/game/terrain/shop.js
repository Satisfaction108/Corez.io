// Dig Royale outfitters: four shop pads on the cardinal rays between the
// Center Vault and each cardinal base. Everything here is paid from BANKED
// gems only, lives on the socket (survives death, resets with the raid), and
// turns the economy into a real progression ladder.

const PAD_RADIUS = 95;

const DRILL_MULT = [1, 1.25, 1.5, 1.8, 2.15, 2.6];
const SATCHEL_BASE = 4000;

const ITEMS = [
    // drills: one tier at a time, lose a tier on death
    { id: "drill1", cat: "drill", tier: 1, name: "Drill I",   price: 400,  desc: "Mines through rock 25% faster." },
    { id: "drill2", cat: "drill", tier: 2, name: "Drill II",  price: 900,  desc: "Mines through rock 50% faster." },
    { id: "drill3", cat: "drill", tier: 3, name: "Drill III", price: 1600, desc: "Mines through rock 80% faster." },
    { id: "drill4", cat: "drill", tier: 4, name: "Drill IV",  price: 2600, desc: "Mines through rock 115% faster." },
    { id: "drill5", cat: "drill", tier: 5, name: "Drill V",   price: 4000, desc: "Mines through rock 160% faster, and you keep it when you die." },
    // gear: passive, permanent for the raid
    // gear: 5 minutes each; `on` is the message that tells you what it is doing
    { id: "scanner",   cat: "gear", name: "Ore Scanner",        price: 1200, desc: "Shows shard and emerald veins within 1500 units on your minimap for 5 minutes.", on: "Veins near you now show on your minimap." },
    { id: "magnet",    cat: "gear", name: "Gem Magnet",         price: 900,  desc: "Pulls in gems from almost twice as far away for 5 minutes.", on: "Gems now come to you from much farther away." },
    { id: "satchel",   cat: "gear", name: "Reinforced Satchel", price: 700,  desc: "Lets you carry 6,000 gems instead of 4,000 for 5 minutes.", on: "Your satchel now holds 6,000." },
    { id: "insurance", cat: "gear", name: "Insurance",          price: 1500, desc: "If you die in the next 5 minutes, a quarter of your satchel gets banked instead of dropped.", on: "If you die, a quarter of your satchel gets banked." },
    { id: "cloak",     cat: "gear", name: "Storm Cloak",        price: 1100, desc: "The storm only does half damage to you for 5 minutes.", on: "The storm now does half damage to you." },
    { id: "boots",     cat: "gear", name: "Quick Treads",       price: 1300, desc: "Move 25% faster for 5 minutes.", on: "You move 25% faster." },
    { id: "plating",   cat: "gear", name: "Armor Plating",      price: 1300, desc: "25% more max health for 5 minutes.", on: "You have 25% more max health." },
    { id: "express",   cat: "gear", name: "Vault Express",      price: 600,  desc: "Vault deposits go twice as fast for 5 minutes.", on: "Your deposits now go twice as fast." },
    { id: "mark",      cat: "gear", name: "Hunter's Mark",      price: 1800, desc: "Each kill is worth an extra 100 points for 5 minutes.", on: "Your kills now pay an extra 100 points." },
    { id: "wind",      cat: "gear", name: "Second Wind",        price: 800,  desc: "Respawn in 7 seconds instead of 15 for the next 5 minutes.", on: "You now respawn in 7 seconds." },
    // kit: consumables, 3 distinct types at a time, used with Z / Q / N
    { id: "charge",    cat: "kit", name: "Seismic Charge", price: 350, max: 3, desc: "Throws a charge at your cursor (up to 500 away) that shatters every rock within 150." },
    { id: "strut",     cat: "kit", name: "Support Strut",  price: 250, max: 3, desc: "Props open everything within 320 of you for 3 minutes: nothing grows back there, and rock that is already regrowing crumbles." },
    { id: "medkit",    cat: "kit", name: "Medkit",         price: 300, max: 3, desc: "Heals half your health on the spot and keeps the storm off you for 3 seconds." },
    { id: "overdrive", cat: "kit", name: "Overdrive Core", price: 450, max: 2, desc: "Double mining power and 30% faster reload for 20 seconds." },
    { id: "anchor",    cat: "kit", name: "Storm Anchor",   price: 400, max: 2, desc: "The storm can't hurt you for 15 seconds." },
    { id: "flash",     cat: "kit", name: "Flash Vault",    price: 500, max: 2, desc: "Banks up to 300 of the gems you're carrying from wherever you are, minus a 30% fee." },
    { id: "bulwark",   cat: "kit", name: "Bulwark",        price: 300, max: 3, desc: "Instantly regrows the dead rock within 260 of you. Instant cover." },
    { id: "decoy",     cat: "kit", name: "Decoy Satchel",  price: 250, max: 3, desc: "Makes you look like you're hauling a full satchel for 20 seconds. Bait." },
    { id: "barrage",   cat: "kit", name: "Rock Barrage",   price: 3000, max: 1, desc: "Hurls 10 chunks of rock at your cursor. Each one that lands takes 9% of a tank's health straight through its shield, so a full volley kills anyone who isn't at full health. Every chunk smashes through two rocks on the way." },
    // sidearms: one mounted at a time, fired with right click
    { id: "flak",  cat: "arm", name: "Annihilator", price: 1500, desc: "Right click fires one huge annihilator shell at your cursor. 7 second reload." },
    { id: "lance", cat: "arm", name: "Drill Lance", price: 1200, desc: "Right click fires a bolt that shatters any rock it hits. 5 second reload." },
    { id: "pod",   cat: "arm", name: "Swarm Barrels", price: 1800, desc: "Two battleship barrels on each side that send seeker drones at your cursor on right click. Burns out after 2.5 minutes." },
];
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

function catalog() {
    return ITEMS.map(i => ({ id: i.id, cat: i.cat, tier: i.tier || 0, name: i.name, price: i.price, max: i.max || 0, desc: i.desc }));
}

function freshState() {
    return { drill: 0, gear: {}, kit: {}, kitOrder: [], arm: null, spent: 0 };
}

// Kit invariants, re-asserted on every read: no zero counts, kitOrder lists
// exactly the held ids (in acquisition order), counts within each item's
// max, never more than KIT_SLOTS ids.
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
    s.kitOrder = s.kitOrder.filter((id, i) => s.kit[id] > 0 && s.kitOrder.indexOf(id) === i);
    for (const id of Object.keys(s.kit)) if (!s.kitOrder.includes(id)) s.kitOrder.push(id);
    while (s.kitOrder.length > KIT_SLOTS) { const drop = s.kitOrder.pop(); delete s.kit[drop]; }
    return s;
}

function stateOf(socket) {
    if (!socket) return null;
    if (!socket.shop) socket.shop = freshState();
    return socket.shop;
}

function resetAll() {
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
    }
}

// `ok` tells the client whether the message is good news (sound + colour).
function talkState(socket, msg, ok = false) {
    if (!socket || !socket.talk) return;
    const s = normalizeKit(stateOf(socket));
    try {
        socket.talk('SHP', JSON.stringify({
            drill: s.drill, gear: Object.keys(s.gear), gearUntil: s.gear, kit: s.kit, kitOrder: s.kitOrder, arm: s.arm, armUntil: s.armUntil || 0,
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
function hasGear(body, id) { return gearActive(shopOf(body), id); }
function magnetMult(body) { return hasGear(body, "magnet") ? 1.9 : 1; }
function satchelCap(body) { return SATCHEL_BASE * (hasGear(body, "satchel") ? 1.5 : 1) * ((global.royaleMods && global.royaleMods.satchelMult) || 1); }
function depositRateMult(body) { return hasGear(body, "express") ? 2 : 1; }
function stormDamageMult(body) {
    if (body && body.stormAnchorUntil && Date.now() < body.stormAnchorUntil) return 0;
    return hasGear(body, "cloak") ? 0.5 : 1;
}
function respawnMs(body) { return hasGear(body, "wind") ? 7000 : 15000; }
function killBonus(body) { return hasGear(body, "mark") ? 100 : 0; }
function keepsDrillOnRespawn(body) { const s = shopOf(body); return !!(s && s.drill >= 5); }

// Body multipliers the entity applies at the end of refreshBodyAttributes.
function applyPassives(body) {
    if (!body) return;
    const s = shopOf(body);
    body.bonusSpeedMult = gearActive(s, "boots") ? 1.25 : 1;
    body.bonusHealthMult = gearActive(s, "plating") ? 1.25 : 1;
    body.gemCap = satchelCap(body);
    try { body.refreshBodyAttributes(); } catch { /* */ }
    if (s && s.arm) attachSidearm(body, s.arm);
}

// ── sidearms ───────────────────────────────────────────────────────────
function sidearmDef(id) {
    const { combineStats } = require('../../lib/definitions/facilitators.js');
    const g = require('../../lib/definitions/gunvals.js');
    // both hidden: the shell appears at the hull and flies at the cursor
    // (reload 3.8 is about 5 seconds; 7.6 about 10)
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
    // two battleship barrels a side, seeker drones on right click
    // Gun X/Y are in the gun's own rotated frame (the client rotates the
    // offset by direction + angle), so for a sideways gun X is how far out
    // on the flank it sits and Y is fore/aft. Two per side, like a battleship.
    if (id === "pod") return [[7, -4.5, 90, 0], [7, 4.5, 90, 0.5], [7, 4.5, 270, 0.25], [7, -4.5, 270, 0.75]].map(([x, y, ang, delay]) => ({
        POSITION: [9, 7, 0.7, x, y, ang, delay],
        PROPERTIES: {
            SHOOT_SETTINGS: combineStats([g.swarm, g.battleship, { reload: 1.15, damage: 1.15, health: 1.1 }]),
            TYPE: "swarm", ALT_FIRE: true, LABEL: "Swarm Barrel", COLOR: 16,
            STAT_CALCULATOR: "swarm",
        },
    }));
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
    const def = sidearmDef(id);
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
            const s = shopOf(body);
            if (!s || !s.arm) return;
            if (body.sidearmGun && body.guns.get(body.sidearmGun.id) === body.sidearmGun) return;
            body.sidearmGun = null;
            setImmediate(() => { try { if (!body.isDead?.()) attachSidearm(body, s.arm); } catch { /* */ } });
        });
    }
    return true;
}

// Twists hand out a sidearm to everyone: mounted for the whole raid, no
// burn-out, and it comes back on every respawn through the define hook.
function grantArm(socket, id, permanent = true) {
    const body = socket && socket.player && socket.player.body;
    const s = stateOf(socket);
    if (!body || !s || !sidearmDef(id)) return false;
    s.arm = id;
    s.armUntil = permanent ? 0 : Date.now() + ARM_BURN_MS;
    attachSidearm(body, id);
    return true;
}

// ── purchases ──────────────────────────────────────────────────────────
function canBuy(socket, item) {
    const s = normalizeKit(stateOf(socket));
    if (!s || !item) return { ok: false, why: "Unknown item." };
    if (item.cat === "drill") {
        if (s.drill >= item.tier) return { ok: false, why: "Already owned." };
        if (item.tier !== s.drill + 1) return { ok: false, why: "Buy Drill " + ["I", "II", "III", "IV", "V"][s.drill] + " first." };
    } else if (item.cat === "gear") {
        if (gearActive(s, item.id)) return { ok: false, why: "That one is already running." };
        if (Object.keys(s.gear).filter(id => gearActive(s, id)).length >= GEAR_MAX) return { ok: false, why: "You can only have " + GEAR_MAX + " gear items running at once." };
    } else if (item.cat === "kit") {
        const have = s.kit[item.id] | 0;
        if (have >= (item.max || 1)) return { ok: false, why: "You already have the most of those you can carry." };
        if (!have && s.kitOrder.length >= KIT_SLOTS) return { ok: false, why: "Your kit is full. It holds 3 kinds of item." };
    } else if (item.cat === "arm") {
        if (s.arm === item.id) return { ok: false, why: "Already mounted." };
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
    const gems = require('./gems.js');
    gems.setBanked(body, bankedOf(socket) - item.price);
    s.spent += item.price;
    let msg = "Bought " + item.name + ".";
    if (item.cat === "drill") s.drill = item.tier;
    else if (item.cat === "gear") {
        s.gear[item.id] = Date.now() + GEAR_MS;
        applyPassives(body);
        msg = item.name + " is running for the next 5 minutes. " + (item.on || "");
    }
    else if (item.cat === "kit") {
        s.kit[item.id] = (s.kit[item.id] | 0) + 1;
        if (!s.kitOrder.includes(item.id)) s.kitOrder.push(item.id);
        const slot = s.kitOrder.indexOf(item.id);
        msg = item.name + " is in kit slot " + (slot + 1) + ".";
    } else if (item.cat === "arm") {
        s.arm = item.id;
        s.armUntil = item.id === "pod" ? Date.now() + ARM_BURN_MS : 0;
        attachSidearm(body, item.id);
        msg = item.name + " mounted. Fire it with right click.";
    }
    body._shopLastBuyAt = Date.now();
    body._shopBought = true;
    try { gems.talkGems(body, 0); } catch { /* */ }
    if (Config.dig_royale) try { require('../gamemodes/scripts/dig_royale.js').onShopBuy(body, item); } catch { /* */ }
    talkState(socket, msg, true);
    return true;
}

// Chest and boss drops hand out kit items without a pad. Returns false when
// the kit is full so the caller can pay gems instead.
function grantKit(socket, itemId, count = 1) {
    const s = normalizeKit(stateOf(socket));
    const item = BY_ID.get(itemId);
    if (!s || !item || item.cat !== "kit") return false;
    const have = s.kit[item.id] | 0;
    if (!have && s.kitOrder.length >= KIT_SLOTS) { talkState(socket, "Your kit is full. It holds 3 kinds of item."); return false; }
    if (have >= (item.max || 1)) { talkState(socket, item.name + " stack full."); return false; }
    s.kit[item.id] = Math.min(item.max || 1, have + count);
    if (!s.kitOrder.includes(item.id)) s.kitOrder.push(item.id);
    talkState(socket, "Found " + item.name + ".", true);
    return true;
}

function randomKitId() {
    const pool = ITEMS.filter(i => i.cat === "kit" && i.id !== "barrage").map(i => i.id);
    return pool[(Math.random() * pool.length) | 0];
}

// ── Rock Barrage ───────────────────────────────────────────────────────
// Ten rock chunks fan out toward the cursor. They are noclip entities moved
// by hand here, so the engine's collision maths never touches them and the
// damage is exactly what the shop says: 9% of the target's max health per
// chunk, straight through the shield (ten landing = 90%). Each chunk
// smashes up to two rocks, and dies on a third, on a raid vault pad, or at
// the end of its range.
const STRUT_RADIUS = 320;
const BARRAGE = { count: 10, speed: 30, range: 950, spread: 0.26, hitFrac: 0.09, bossFrac: 0.015, pierce: 2, radius: 14 };
const barrageShards = [];

function launchBarrage(body, tx, ty) {
    let dx = (+tx || 0) - body.x, dy = (+ty || 0) - body.y;
    if (!(Math.hypot(dx, dy) > 1)) { dx = Math.cos(body.facing || 0); dy = Math.sin(body.facing || 0); }
    const base = Math.atan2(dy, dx);
    const now = Date.now();
    for (let i = 0; i < BARRAGE.count; i++) {
        // an even fan with a little scatter, and staggered speeds so the
        // volley arrives as a spray rather than a flat wall
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
    // Credit the owner: the next mortality check reads collisionArray before
    // it is cleared, and a sliver of damageReceived raises the usual damage
    // event (bots fight back, bases go contested).
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
// Dragging an item out of its slot throws the whole stack away. No refund.
function dropKit(socket, slot) {
    const body = socket && socket.player && socket.player.body;
    const s = normalizeKit(stateOf(socket));
    if (!body || !s) return false;
    const id = s.kitOrder[slot | 0];
    if (!id) return false;
    const item = BY_ID.get(id);
    delete s.kit[id];
    s.kitOrder = s.kitOrder.filter(k => k !== id);
    talkState(socket, "Dropped the " + (item ? item.name : "item") + ".");
    return true;
}

function useKit(socket, slot, tx, ty, itemId) {
    const body = socket && socket.player && socket.player.body;
    const s = normalizeKit(stateOf(socket));
    if (!body || body.isDead?.() || !s) return false;
    let id = s.kitOrder[slot | 0];
    // the client names the item it pressed; a slot that compacted since
    // must never fire a different item
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
            msg = broke ? ("Seismic charge: " + broke + " rocks shattered.") : "Seismic charge fizzled on open ground.";
            if (Config.dig_royale) try { require('../gamemodes/scripts/dig_royale.js').fxAt(cx, cy, "charge"); } catch { /* */ }
            break;
        }
        case "strut": {
            if (!tg) break;
            // A zone, not a list of rocks: anything that dies inside it later
            // stays open too, and rock that was already mid-regrow crumbles
            // (the old version skipped those, so struts looked like they
            // did nothing while the wall kept coming back).
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
            msg = "Rock Barrage away.";
            break;
        }
        case "medkit": {
            if (!body.health || body.health.amount >= body.health.max * 0.995) { msg = "You're already at full health."; break; }
            body.health.amount = Math.min(body.health.max, body.health.amount + body.health.max * 0.5);
            // inside the storm the heal used to vanish in a second: the medkit
            // also buys three seconds without storm damage so it visibly lands
            body.stormAnchorUntil = Math.max(body.stormAnchorUntil || 0, now + 3000);
            used = true;
            msg = "Medkit used. Half your health back, and the storm is off you for 3 seconds.";
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
            msg = "Anchor dropped. The storm can't touch you for 15 seconds.";
            break;
        }
        case "flash": {
            const carried = body.carriedGems | 0;
            if (carried < 15) { msg = "Not enough in the satchel to bother banking."; break; }
            const take = Math.min(300, carried);
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
            try { require('./milestones.js').checkBanked(body); } catch { /* */ }
            used = true;
            msg = "Flash vault: " + credit + " gems banked.";
            break;
        }
        case "bulwark": {
            if (!tg) break;
            let n = 0;
            for (const rock of tg.rocks.values()) {
                if (!rock || rock.alive || rock.growing || rock.canyon || !rock.worldPoly) continue;
                const rx = rock.worldCx || rock.wx, ry = rock.worldCy || rock.wy;
                const d2 = (rx - body.x) ** 2 + (ry - body.y) ** 2;
                if (d2 > 260 * 260 || d2 < 110 * 110) continue;
                rock.noRegrowUntil = 0;
                try { tg.startRegrow(rock, now + n * 40); n++; } catch { /* */ }
                if (n >= 14) break;
            }
            used = n > 0;
            msg = used ? "Bulwark: the wall rises around you." : "No fallen rock nearby to raise.";
            break;
        }
        case "decoy": {
            body.decoyUntil = now + 20_000;
            try { require('./gems.js').updateSatchel(body); } catch { /* */ }
            used = true;
            msg = "Decoy up. You look fully loaded for 20 seconds.";
            break;
        }
    }
    if (used) {
        body._kitCdUntil = now + 600;
        // every use has a look: the client keys the effect off the item id
        if (Config.dig_royale) try { require('../gamemodes/scripts/dig_royale.js').fxAt(body.x, body.y, "kit_" + id); } catch { /* */ }
        else if (socket) { try { socket.talk('FX', Math.round(body.x), Math.round(body.y), "kit_" + id); } catch { /* */ } }
        s.kit[id] = (s.kit[id] | 0) - 1;
        if (s.kit[id] <= 0) {
            delete s.kit[id];
            s.kitOrder = s.kitOrder.filter(k => k !== id);
        }
    }
    talkState(socket, msg, used);
    return used;
}

// ── death ──────────────────────────────────────────────────────────────
function onDeath(body) {
    const s = shopOf(body);
    if (!s) return { drillLost: 0 };
    let drillLost = 0;
    if (s.drill > 0 && s.drill < 5) { s.drill--; drillLost = 1; }
    if (body.socket) talkState(body.socket, drillLost ? "Drill dropped a tier." : "");
    return { drillLost };
}

// ── pad tick ───────────────────────────────────────────────────────────
// A shop pad is a trigger zone and nothing more: stand on it to browse,
// step off to close. No cover, no timer, no lockout - the risk of shopping
// in the open is the whole point.
function actorBody(actor) { return actor && actor.body ? actor.body : actor; }

// The pad is drawn as a hexagon 1.16x the pad radius (flat top); collide
// with that shape so the door is exactly where it looks (padGeom.js).
const padGeom = require('./padGeom.js');
const HEX_SCALE = padGeom.HEX.scale;
function insideHexagon(dx, dy, R) { return padGeom.insideNgon(dx, dy, R, 6); }
const shopKey = (pad) => 'shop:' + pad.id;
const SHOP_IDLE_MS = 60_000;      // browse time before the shop closes on you
const SHOP_LOCK_MS = 20_000;      // one visit per purchase
const ARM_BURN_MS = 150_000;      // swarm barrels burn out after 2.5 minutes
const GEAR_MS = 300_000;          // every gear item runs for 5 minutes
const GEAR_MAX = 4;               // at most four running at once
function shopEject(body, pad, msg, lockMs) {
    body._shopExpel = pad;                // a steady shove until the hull is clear
    padGeom.keepOut(body, pad, 4, shopKey(pad), 'expel');
    body._shopReentryUntil = Date.now() + lockMs;
    body._shopReentryPad = pad;
    if (msg) { try { body.sendMessage(msg + " You can come back in " + Math.round(lockMs / 1000) + " seconds."); } catch { /* */ } }
}
// A shop pad is a restroom: one shopper at a time, bots never set foot on it,
// and nobody inside can be shot or shoot (padSafe, set in the loader).
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
            shopEject(body, s, "Shop is occupied.", 3000);
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
            if (was) { body.shopOnPad = false; body.socket.talk('SHU', 0, -1, ""); }
            continue;
        }
        let pad = null;
        for (const s of list) if (s._occupant === body) { pad = s; break; }
        let on = !!pad;
        if (on && !was) { body._shopSince = now; body._shopBought = false; }
        if (on) {
            // the browse clock only counts idle time
            const busyAt = Math.max(body._shopSince || now, body._shopLastBuyAt || 0);
            if (now - busyAt > SHOP_IDLE_MS) {
                shopEject(body, pad, "Shop closed. Move along.", 10_000);
                on = false;
            }
        } else if (was && body._shopBought && body._shopPad) {
            // walked off after buying: one visit per purchase
            shopEject(body, body._shopPad, "Come back for more later.", SHOP_LOCK_MS);
        }
        if (on) body._shopPad = pad;
        body.shopOnPad = on;
        if (was !== on) body.socket.talk('SHU', on ? 1 : 0, on ? pad.id : -1, on ? pad.name : "");
    }
}

module.exports = {
    ITEMS, BY_ID, getShops, snapshot, catalog, stateOf, freshState, resetAll, talkState, dropKit,
    miningMult, hasGear, magnetMult, satchelCap, depositRateMult, stormDamageMult, respawnMs, killBonus,
    keepsDrillOnRespawn, applyPassives, attachSidearm, detachSidearm, buy, grantKit, grantArm, randomKitId, useKit, onDeath, tick,
    PAD_RADIUS, DRILL_MULT, insideHexagon, HEX_SCALE, launchBarrage, BARRAGE, STRUT_RADIUS,
};
