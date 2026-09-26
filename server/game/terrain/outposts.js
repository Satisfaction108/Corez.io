

const gems = require('./gems.js');
const war = require('./war.js');
const milestones = require('./milestones.js');
const padGeom = require('./padGeom.js');

const PAD_RADIUS   = 95;
const EFFICIENCY   = 0.8;     
const DEPOSIT_RATE = 300;     
const PROGRESS_MS  = 50;
const MIN_DEPOSIT  = 15;
const HEAL_FRAC_PS = 0.005;   
const HEAL_GRACE_MS = 5000;   
const NEUTRAL_YELLOW = "#caca4e";   

let outposts = null;

// The tutorial teaches the Dig Royale base: owned by one player, drawn in the
// site's own colour. Everything royale-only (lobby, raid scoring) stays
// behind Config.dig_royale.
const ownerBases = () => !!(Config.dig_royale || Config.tutorial);

let _dustHooks = null;
function dustHooks() { return _dustHooks || (_dustHooks = require('../../accounts/game/dustHooks.js')); }

function getOutposts() {
    if (outposts && outposts.length) return outposts;
    const tg = global.gameManager && global.gameManager.terrainGrid;
    if (!tg || !tg.outpostSites || !tg.outpostSites.length) return outposts || [];
    outposts = tg.outpostSites.map(s => ({
        id: s.id,
        name: s.name,
        x: s.x,
        y: s.y,
        r: PAD_RADIUS,
        team: 0,
        ownerId: 0,
        ownerKey: null,
        color: s.color || null,
        banner: null,
        locked: false,
    }));
    return outposts;
}

// Persistent owner identity: survives death + respawn (body ids do not).
function ownerKeyFor(body) {
    if (!body) return null;
    if (body.socket && body.socket.id) return "s:" + body.socket.id;
    if (body.isBot) return "b:" + (body.botFamilyId ?? body.id);
    return null;
}

// Release every site owned by `key` back to neutral (disconnect cleanup).
function releaseOwner(key) {
    if (!key) return;
    for (const site of getOutposts()) {
        if (site.ownerKey !== key) continue;
        site.ownerId = 0;
        site.ownerKey = null;
        site.team = 0;
        if (site.banner && !site.banner.isDead?.()) {
            try {
                site.banner.team = TEAM_ENEMIES;
                site.banner.color.base = "#6a6f7a";
            } catch { /* */ }
        }
    }
}

// Point every site owned by `key` at the owner's fresh body.
function rebindOwner(key, body) {
    if (!key || !body) return;
    for (const site of getOutposts()) {
        if (site.ownerKey !== key) continue;
        site.ownerId = body.id;
        if (site.banner && !site.banner.isDead?.()) {
            try {
                site.banner.team = body.team;
                if (ownerBases() && site.color) site.banner.color.base = site.color;
            } catch { /* */ }
        }
    }
}

function snapshot() {
    return getOutposts().map(o => ({ id: o.id, name: o.name, x: o.x, y: o.y, r: o.r }));
}

function stateSnapshot() {
    return getOutposts().map(o => ({
        id: o.id,
        t: ownerBases() ? (o.ownerId || 0) : o.team,
        h: o.banner && !o.banner.isDead()
            ? Math.max(0, Math.min(1, o.banner.health.amount / o.banner.health.max))
            : 0,
        c: o.color || "",
        o: o.ownerId || 0,
        l: o.occupyLeft || 0,
        cont: ((o._contestedUntil || 0) > Date.now()) ? 1 : 0,
    }));
}

// Owned pads for a team - the forward-respawn candidates.
function ownedBy(team) {
    return getOutposts().filter(o => o.team === team && o.banner && !o.banner.isDead());
}

function announce(msg) {
    // Tutorial: capture/destruction fanfare is noise while someone is being
    // taught - every event on that server is a scripted lesson beat anyway.
    if (Config.tutorial) return;
    global.gameManager.socketManager.broadcast(msg);
}

const teamName = (team) => team === TEAM_BLUE ? "Blue" : team === TEAM_RED ? "Red" : "Someone";

// Base-bank names wear the bank's fixed color in announcements (royale only;
// drawText §codes accept raw hex, other modes fall back to plain names).
const siteName = (s) => (Config.dig_royale && s && s.color ? "§" + s.color + "§" + s.name + "§reset§" : (s ? s.name : "Outpost"));

function spawnStructure(site, team, owner = null) {
    site.team = team;
    site.ownerId = owner && owner.id ? owner.id : 0;
    site.ownerKey = owner ? ownerKeyFor(owner) : null;
    const o = new Entity({ x: site.x, y: site.y });
    o.define('outpostBanner');
    o.team = team === 0 ? TEAM_ENEMIES : team;
    if (ownerBases()) {
        o.color.base = site.ownerId && site.color ? site.color : "#6a6f7a";
        o.team = site.ownerId ? (owner.team || TEAM_ENEMIES) : TEAM_ENEMIES;
    } else {
        o.color.base = team === 0 ? NEUTRAL_YELLOW : getTeamColor(team);
    }
    
    
    o.name = "";
    o.isOutpostBanner = true;
    o.padSite = site;             // the pad this structure stands on (base wall)
    
    
    
    o.pinX = site.x;
    o.pinY = site.y;
    // Tutorial: locked until the base lesson, so it can't be taken early.
    if (site.locked) o.godmode = true;
    // Tutorial: the lesson is "an outpost is a thing you break to take", and
    // a beginner is not going to chew 9000 HP off a RESIST-50 structure to
    // learn it. Thin it right down so the objective lands in a few seconds -
    // the step that follows says out loud that a real one is far tougher.
    if (Config.tutorial && o.health && o.health.max) {
        o.health.max *= 0.045;
        o.health.amount = o.health.max;
        if (o.shield) { o.shield.max = 0; o.shield.amount = 0; }
    }
    o.on('damage', ({ damageInflictor = [] } = {}) => {
        const attacker = damageInflictor
            .map(source => {
                let root = source, hops = 0;
                while (root?.master && root.master !== root && hops++ < 8) root = root.master;
                return root;
            })
            .find(root => root && (root.isPlayer || root.isBot));
        if (attacker) {
            site._lastHitter = attacker;
            if (Config.dig_royale && site.ownerId && attacker.id !== site.ownerId) {
                const t = Date.now();
                site._contestedUntil = t + 10000;
                if (t - (site._contestAnnAt || 0) > 25000) {
                    site._contestAnnAt = t;
                    announce(siteName(site) + " is contested. " + (attacker.name || "Someone") + " is breaking it.");
                }
            }
        }
    });
    o.on('dead', () => onStructureDeath(site));
    site.banner = o;
    site._hpTrack = o.health.max;   
    site._lastHitAt = 0;            
}

function killerOf(dead, site) {
    for (const k of (dead && dead.finalKillers) || []) {
        if (k && (k.isPlayer || k.isBot)) return k;
    }
    if (site && site._lastHitter && !site._lastHitter.isDead?.()) return site._lastHitter;
    return site && site._lastHitter || null;
}

function onStructureDeath(site) {
    const dead = site.banner;
    site.banner = null;
    if (ownerBases()) {
        if (Config.dig_royale) try {
            if (require('../gamemodes/scripts/dig_royale.js').isLobbyPhase()) {
                site.ownerId = 0;
                site.team = 0;
                return;
            }
        } catch { /* */ }
        const killer = killerOf(dead, site);
        if (killer && killer.id !== site.ownerId) {
            spawnStructure(site, killer.team, killer);
            announce(`${killer.name || "Someone"} captured the ${siteName(site)}!`);
            if (Config.dig_royale) try { require('../gamemodes/scripts/dig_royale.js').onCapture(killer, site); } catch { /* */ }
        } else {
            spawnStructure(site, 0, null);
            if (site.ownerId) announce(`The ${siteName(site)} has fallen!`);
        }
        return;
    }
    if (site.team === 0) {
        
        let team = 0;
        for (const k of (dead && dead.finalKillers) || []) {
            if (k && (k.team === TEAM_BLUE || k.team === TEAM_RED)) { team = k.team; break; }
        }
        if (team) {
            spawnStructure(site, team);
            announce(`${teamName(team)} has captured the ${site.name}!`);
        } else {
            spawnStructure(site, 0);   
        }
    } else {
        const owner = site.team;
        let capturingTeam = 0;
        for (const k of (dead && dead.finalKillers) || []) {
            if (k && (k.team === TEAM_BLUE || k.team === TEAM_RED) && k.team !== owner) {
                capturingTeam = k.team;
                break;
            }
        }
        if (capturingTeam) {
            spawnStructure(site, capturingTeam);
            announce(`${teamName(capturingTeam)} captured the ${site.name} from ${teamName(owner)}!`);
        } else {
            spawnStructure(site, 0);
            announce(`The ${site.name} has fallen - ${teamName(owner)} lost it!`);
        }
    }
}

function actorBody(actor) {
    return actor && actor.body ? actor.body : actor;
}

function tick(players, dtMs) {
    const list = getOutposts();
    if (!list.length) return;
    if (Config.dig_royale) {
        try {
            if (require('../gamemodes/scripts/dig_royale.js').isLobbyPhase()) {
                for (const player of players) {
                    const body = actorBody(player);
                    if (body) body.outpostOnPad = false;
                }
                // Drop banners without a death event so capture spam cannot fire.
                for (const site of list) {
                    site.ownerId = 0;
                    site.team = 0;
                    const b = site.banner;
                    site.banner = null;
                    if (b && !b.isDead?.()) {
                        try { if (b.removeAllListeners) b.removeAllListeners("dead"); } catch { /* */ }
                        try { b.destroy(); } catch {
                            try { b.health.amount = -100; } catch { /* */ }
                        }
                    }
                }
                return;
            }
        } catch { /* fall through */ }
    }
    const now = Date.now();

    for (const site of list) {
        // Owner body is gone from the world. A connected owner's claim
        // survives death (they respawn onto it); anything else releases so
        // a ghost's base never bounces everyone forever.
        if (site.ownerId) {
            try {
                if (typeof entities !== "undefined" && !entities.has(site.ownerId)) {
                    let awaitRespawn = false;
                    if (site.ownerKey && site.ownerKey.startsWith("s:")) {
                        const sid = site.ownerKey.slice(2);
                        const clients = (global.gameManager && global.gameManager.socketManager &&
                            global.gameManager.socketManager.clients) || [];
                        awaitRespawn = clients.some(c => c && c.id === sid);
                    }
                    if (!awaitRespawn) {
                        site.ownerId = 0;
                        site.ownerKey = null;
                    }
                }
            } catch { /* */ }
        }
        if (!site.banner) spawnStructure(site, site.team);
        
        
        
        
        const b = site.banner;
        if (b && !b.isDead()) {
            if (b.health.amount < (site._hpTrack ?? b.health.amount)) site._lastHitAt = now;
            site._hpTrack = b.health.amount;
            if (b.health.amount < b.health.max &&
                now - (site._lastHitAt || 0) >= (Config.dig_royale ? 12000 : HEAL_GRACE_MS)) {
                b.health.amount = Math.min(b.health.max,
                    b.health.amount + b.health.max * HEAL_FRAC_PS * (dtMs / 1000));
            }
        }
        // PIN the structure back onto its pad each tick - permanent, immovable.
        if (b) {
            b.x = site.x; b.y = site.y;
            b.velocity.x = 0; b.velocity.y = 0;
            b.accel.x = 0;    b.accel.y = 0;
        }
    }

    for (const player of players) {
        const body = actorBody(player);
        if (!body || body.isGhost) continue;
        if (body.isDead()) {
            if (body.outpostDeposit) { body.outpostDeposit = null; talkOutpostProgress(body); }
            if (body.outpostOnPad && body.socket) body.socket.talk('OU', 0);
            body.outpostOnPad = false;
            body.onBasePad = false;
            continue;
        }

        
        // Royale bases are the drawn octagon (padGeom), the same shape the
        // occupy clock and the wall use; a bare r circle left an outer ring
        // where the clock ran but the deposit panel never opened.
        let pad = null;
        for (const o of list) {
            if (ownerBases()) { if (padGeom.insidePad(o, body.x, body.y)) { pad = o; break; } continue; }
            const dx = body.x - o.x, dy = body.y - o.y;
            if (dx * dx + dy * dy < o.r * o.r) { pad = o; break; }
        }

        
        const onOwnPad = ownerBases()
            ? !!(pad && pad.ownerId === body.id && pad.banner && !pad.banner.isDead())
            : !!(pad && pad.team === body.team && pad.banner && !pad.banner.isDead());
        body.onBasePad = !!pad;
        const was = !!body.outpostOnPad;
        body.outpostOnPad = onOwnPad;
        if (was !== onOwnPad && body.socket) {
            
            
            body.socket.talk('OU', onOwnPad ? 1 : 0);
            if (!onOwnPad && body.outpostDeposit) {
                body.outpostDeposit = null;
                talkOutpostProgress(body);
            }
        }

        const d = body.outpostDeposit;
        if (!d) continue;
        if (body.health.amount < d.lastHealth - 1e-3 && !body._inStorm) {
            body.outpostDeposit = null;
            talkOutpostProgress(body);
            continue;
        }
        d.lastHealth = body.health.amount;
        
        
        
        let rateMult = 1;
        if (body.socket) { try { rateMult = require('./shop.js').depositRateMult(body); } catch { /* */ } }
        d.spill = (d.spill || 0) + (DEPOSIT_RATE * rateMult * dtMs) / 1000;
        const chunk = Math.min(
            Math.ceil(d.remaining / EFFICIENCY - 1e-9),
            body.carriedGems | 0,
            Math.floor(d.spill)
        );
        if (chunk <= 0) {
            if ((body.carriedGems | 0) <= 0 || d.remaining <= 0) {
                body.outpostDeposit = null;
                talkOutpostProgress(body);
            }
            continue;
        }
        d.spill -= chunk;
        d.remaining = Math.max(0, d.remaining - chunk * EFFICIENCY);
        const carriedBefore = body.carriedGems | 0;
        body.carriedGems = Math.max(0, carriedBefore - chunk);
        // gemdust leaves with its share of the satchel, at the base's efficiency
        if (Config.dig_royale) { try { dustHooks().onSatchelOut(body, chunk, carriedBefore, EFFICIENCY); } catch { /* */ } }
        const socket = body.socket;
        if (socket) {
            socket.gemBanked = (socket.gemBanked || 0) + chunk * EFFICIENCY;
            body.bankedGems = socket.gemBanked;
            milestones.checkBanked(body);
            war.add(body.team, chunk * EFFICIENCY);
            if (Config.dig_royale) {
                try { require('../gamemodes/scripts/dig_royale.js').onBanked(body, chunk * EFFICIENCY); } catch { /* */ }
            }
        } else if (Config.dig_royale) {
            body.botBanked = (body.botBanked || 0) + chunk * EFFICIENCY;
            body.bankedGems = body.botBanked;
            try { require('../gamemodes/scripts/dig_royale.js').onBanked(body, chunk * EFFICIENCY); } catch { /* */ }
        }
        const done = d.remaining <= 0.5;
        if (done || now - d.lastTalk >= PROGRESS_MS) {
            if (!done) d.lastTalk = now;
            gems.updateSatchel(body);
            gems.talkGems(body, 0);
            if (done && socket) socket.talk('VP', 0, d.total);
            else talkOutpostProgress(body);
        }
        if (done) {
            body.outpostDeposit = null;
            body.carriedGems = body.carriedGems | 0;
            if (socket) {
                socket.gemBanked = Math.round(socket.gemBanked);
                body.bankedGems = socket.gemBanked;
            }
            gems.updateSatchel(body);
            if (Config.dig_royale) { try { dustHooks().onBankDone(body); } catch { /* */ } }
        }
    }
}

function talkOutpostProgress(body) {
    if (!body.socket) return;
    const d = body.outpostDeposit;
    body.socket.talk('VP', d ? Math.ceil(d.remaining) : 0, d ? d.total : 0);
}

function requestDeposit(socket, amount) {
    const body = socket.player && socket.player.body;
    if (!body || body.isDead() || !body.outpostOnPad) return;
    amount = Math.floor(amount);
    const carried = body.carriedGems | 0;
    if (!(amount > 0) || carried < MIN_DEPOSIT) return;
    const total = Math.min(amount, carried);
    
    
    
    
    const credited = Math.round(total * EFFICIENCY);
    body.outpostDeposit = {
        remaining: credited,
        total: credited,
        spill: (body.outpostDeposit && body.outpostDeposit.spill) || 0,
        lastHealth: body.health.amount,
        lastTalk: 0,
    };
    talkOutpostProgress(body);
}

function requestCancel(socket) {
    const body = socket.player && socket.player.body;
    if (body && body.outpostDeposit) {
        body.outpostDeposit = null;
        talkOutpostProgress(body);
    }
}

module.exports = {
    tick, snapshot, stateSnapshot, ownedBy, getOutposts,
    requestDeposit, requestCancel, EFFICIENCY, ownerKeyFor, rebindOwner, releaseOwner,
    // Tutorial: put one site back to neutral (optionally locked), fresh banner.
    resetSite(id, locked = false) {
        const site = getOutposts().find(s => s.id === id);
        if (!site) return;
        site.locked = !!locked;
        site.ownerId = 0;
        site.ownerKey = null;
        site.team = 0;
        site._lastHitter = null;
        const b = site.banner;
        site.banner = null;
        if (b && !b.isDead?.()) {
            try { if (b.removeAllListeners) b.removeAllListeners("dead"); } catch { /* */ }
            try { b.destroy(); } catch { try { b.health.amount = -100; } catch { /* */ } }
        }
        spawnStructure(site, 0, null);
    },
    // Tutorial fallback: hand a site straight to `body` (fresh banner in its
    // colours), for a learner who could not break the practice base in time.
    claimSite(id, body) {
        const site = getOutposts().find(s => s.id === id);
        if (!site || !body) return;
        site.locked = false;
        site._lastHitter = null;
        const b = site.banner;
        site.banner = null;
        if (b && !b.isDead?.()) {
            try { if (b.removeAllListeners) b.removeAllListeners("dead"); } catch { /* */ }
            try { b.destroy(); } catch { try { b.health.amount = -100; } catch { /* */ } }
        }
        spawnStructure(site, body.team, body);
    },
    lockSite(id, locked) {
        const site = getOutposts().find(s => s.id === id);
        if (!site) return;
        site.locked = !!locked;
        if (site.banner && !site.banner.isDead?.()) site.banner.godmode = !!locked;
    },
    resetRoyale() {
        for (const site of getOutposts()) {
            site.ownerId = 0;
            site.ownerKey = null;
            site.team = 0;
            const b = site.banner;
            site.banner = null;
            if (b && !b.isDead?.()) {
                try { if (b.removeAllListeners) b.removeAllListeners("dead"); } catch { /* */ }
                try { b.destroy(); } catch { try { b.health.amount = -100; } catch { /* */ } }
            }
        }
    },
};
