

const gems = require('./gems.js');
const war = require('./war.js');
const milestones = require('./milestones.js');

const PAD_RADIUS   = 95;    
const DEPOSIT_RATE = 300;   
const PROGRESS_MS  = 50;   

let vaults = null;

function getVaults() {
    if (Config.dig_royale) {
        if (vaults && vaults.length) return vaults;
        const tg = global.gameManager && global.gameManager.terrainGrid;
        if (!tg || !tg.vaultSites || !tg.vaultSites.length) return [];
        vaults = tg.vaultSites.map(s => ({
            x: s.x, y: s.y, r: s.r || PAD_RADIUS, team: 0, rainbow: true,
        }));
        return vaults;
    }
    if (vaults) return vaults;
    // Tutorial: one pad per learner plot instead of the two team vaults.
    if (Config.tutorial) {
        vaults = require('./tutorialPlots.js').vaultSites();
        return vaults;
    }
    const room = global.gameManager.room;
    if (!room || !room.width) return [];
    const tileW = room.width / (room.xgrid || 15);
    vaults = [
        { x: -room.width / 2 + tileW / 2, y: 0, r: PAD_RADIUS, team: TEAM_BLUE },
        { x:  room.width / 2 - tileW / 2, y: 0, r: PAD_RADIUS, team: TEAM_RED  },
    ];
    return vaults;
}

// Compact list for the TG snapshot so every client can draw the doors.
function snapshot() {
    return getVaults().map(v => ({ x: v.x, y: v.y, r: v.r, team: v.team, rainbow: !!v.rainbow }));
}

function talkProgress(body) {
    if (!body.socket) return;
    const d = body.vaultDeposit;
    body.socket.talk('VP', d ? Math.ceil(d.remaining) : 0, d ? d.total : 0);
}

function cancelDeposit(body, notify = true) {
    if (!body.vaultDeposit) return;
    body.vaultDeposit = null;
    if (notify) talkProgress(body);
}

const MIN_DEPOSIT = 15;  

function actorBody(actor) {
    return actor && actor.body ? actor.body : actor;
}

function setBanked(body, amount) {
    amount = Math.max(0, amount);
    if (body.socket) body.socket.gemBanked = amount;
    else body.botBanked = amount;
    body.bankedGems = amount;
    return amount;
}

function depositFor(body, amount) {
    if (!body || body.isDead() || !body.vaultOnPad) return false;
    amount = Math.floor(amount);
    const carried = body.carriedGems | 0;
    if (!(amount > 0) || carried < MIN_DEPOSIT) return false;
    const total = Math.min(amount, carried);
    body.vaultDeposit = {
        remaining: total,
        total,
        spill: 0,
        lastHealth: body.health.amount,
        lastTalk: 0,
    };
    talkProgress(body);
    return true;
}

function requestDeposit(socket, amount) {
    return depositFor(socket && socket.player && socket.player.body, amount);
}

function requestCancel(socket) {
    const body = socket.player && socket.player.body;
    if (body) cancelDeposit(body);
}

function tick(actors, dtMs) {
    const list = getVaults();
    if (!list.length) return;
    // BR lobby/idle: playground only - no banking until scatter.
    if (Config.dig_royale) {
        try {
            if (require('../gamemodes/scripts/dig_royale.js').isLobbyPhase()) {
                for (const actor of actors) {
                    const body = actorBody(actor);
                    if (body) body.vaultOnPad = false;
                }
                return;
            }
        } catch { /* fall through */ }
    }
    const now = Date.now();
    for (const actor of actors) {
        const body = actorBody(actor);
        if (!body || body.isGhost) continue;
        if (body.isDead()) {
            if (body.vaultOnPad) { body.vaultOnPad = false; }
            cancelDeposit(body, false);
            continue;
        }

        let pad = null;
        for (const v of list) {
            if (!Config.dig_royale && v.team !== body.team) continue;
            const dx = body.x - v.x, dy = body.y - v.y;
            if (dx * dx + dy * dy < v.r * v.r) { pad = v; break; }
        }

        const was = !!body.vaultOnPad;
        body.vaultOnPad = !!pad;
        if (was !== body.vaultOnPad && body.socket) {
            body.socket.talk('VU', body.vaultOnPad ? 1 : 0);
            if (!body.vaultOnPad) cancelDeposit(body);
        }

        const d = body.vaultDeposit;
        if (!d) continue;

        
        if (body.health.amount < d.lastHealth - 1e-3) {
            cancelDeposit(body);
            continue;
        }
        d.lastHealth = body.health.amount;

        
        
        
        d.spill = (d.spill || 0) + (DEPOSIT_RATE * dtMs) / 1000;
        const chunk = Math.min(d.remaining, body.carriedGems | 0, Math.floor(d.spill));
        if (chunk <= 0) {
            if ((body.carriedGems | 0) <= 0 || d.remaining <= 0) cancelDeposit(body);
            continue;
        }
        d.spill -= chunk;
        d.remaining -= chunk;
        body.carriedGems = Math.max(0, (body.carriedGems | 0) - chunk);
        const banked = body.socket ? (body.socket.gemBanked || 0) : (body.botBanked || 0);
        if (body.isBot) body.botGemsBanked = (body.botGemsBanked || 0) + chunk;
        setBanked(body, banked + chunk);
        war.add(body.team, chunk);
        milestones.checkBanked(body);

        const done = d.remaining <= 0;
        if (done || now - d.lastTalk >= PROGRESS_MS) {
            if (!done) d.lastTalk = now;
            gems.updateSatchel(body);
            gems.talkGems(body, 0);
            if (done && body.socket) body.socket.talk('VP', 0, d.total);
            else talkProgress(body);
        }
        if (done) {
            body.vaultDeposit = null;
            body.carriedGems = body.carriedGems | 0;
            const banked = body.socket ? (body.socket.gemBanked || 0) : (body.botBanked || 0);
            setBanked(body, Math.round(banked));
            gems.updateSatchel(body);
        }
    }
}

module.exports = { tick, snapshot, requestDeposit, requestCancel, depositFor, getVaults };
