

const gems = require('./gems.js');
const war = require('./war.js');
const milestones = require('./milestones.js');

const PAD_RADIUS   = 95;
const DEPOSIT_RATE = 300;
const PROGRESS_MS  = 50;
const PAD_EJECT_MS = 10_000;

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

function releasePad(body) {
    const v = body && body._vaultSite;
    body._vaultSite = null;
    if (v && v._depositor === body) v._depositor = null;
}

function padBusy(pad, body) {
    const d = pad && pad._depositor;
    return !!(d && d !== body && !d.isDead?.() && d.vaultDeposit);
}

function claimPad(pad, body) {
    if (!pad || padBusy(pad, body)) return false;
    releasePad(body);
    pad._depositor = body;
    body._vaultSite = pad;
    return true;
}

function cancelDeposit(body, notify = true) {
    if (!body || !body.vaultDeposit) { if (body) releasePad(body); return; }
    body.vaultDeposit = null;
    releasePad(body);
    if (notify) talkProgress(body);
}

function ejectFromPad(body, pad, msg) {
    if (!body || body.isDead?.()) return;
    const dx = body.x - pad.x, dy = body.y - pad.y;
    const d = Math.hypot(dx, dy);
    const n = d < 1e-3 ? Math.random() * Math.PI * 2 : Math.atan2(dy, dx);
    body.x = pad.x + Math.cos(n) * (pad.r + 28);
    body.y = pad.y + Math.sin(n) * (pad.r + 28);
    try {
        const tg = global.gameManager.terrainGrid;
        if (tg && tg.pushCircleFromVoronoi) tg.pushCircleFromVoronoi(body, body.realSize || 60);
    } catch { /* */ }
    body.velocity.x = Math.cos(n) * 9;
    body.velocity.y = Math.sin(n) * 9;
    body._vaultPadSince = 0;
    if (msg) { try { body.sendMessage(msg); } catch { /* */ } }
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
    if (Config.dig_royale) {
        let pad = null;
        for (const v of getVaults()) {
            const dx = body.x - v.x, dy = body.y - v.y;
            if (dx * dx + dy * dy < v.r * v.r) { pad = v; break; }
        }
        if (!pad) return false;
        if (!claimPad(pad, body)) {
            const t = Date.now();
            if (t - (body._vaultBusyAt || 0) > 3000) {
                body._vaultBusyAt = t;
                try { body.sendMessage("Vault is busy. One miner at a time."); } catch { /* */ }
            }
            return false;
        }
    }
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
        if (Config.dig_royale) {
            if (pad && !was) body._vaultPadSince = now;
            if (!pad) {
                body._vaultPadSince = 0;
                if (was) cancelDeposit(body, !!body.socket);
            } else if (body._vaultPadSince && now - body._vaultPadSince > PAD_EJECT_MS) {
                const had = !!body.vaultDeposit;
                cancelDeposit(body, !!body.socket);
                ejectFromPad(body, pad, had ? "Time up. Move along." : "No camping the vault.");
                continue;
            } else if (body.vaultDeposit && body._vaultSite && body._vaultSite !== pad) {
                // Walked to a different pad mid-deposit: move the lock or stop.
                if (!claimPad(pad, body)) { cancelDeposit(body, !!body.socket); continue; }
            } else if (body.vaultDeposit && !body._vaultSite) {
                if (!claimPad(pad, body)) { cancelDeposit(body, !!body.socket); continue; }
            }
        }
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
        if (Config.dig_royale) {
            try { require('../gamemodes/scripts/dig_royale.js').onBanked(body, chunk); } catch { /* */ }
        }

        const done = d.remaining <= 0;
        if (done || now - d.lastTalk >= PROGRESS_MS) {
            if (!done) d.lastTalk = now;
            gems.updateSatchel(body);
            gems.talkGems(body, 0);
            if (done && body.socket) body.socket.talk('VP', 0, d.total);
            else talkProgress(body);
        }
        if (done) {
            const padDone = pad;
            body.vaultDeposit = null;
            releasePad(body);
            body.carriedGems = body.carriedGems | 0;
            const banked = body.socket ? (body.socket.gemBanked || 0) : (body.botBanked || 0);
            setBanked(body, Math.round(banked));
            gems.updateSatchel(body);
            if (Config.dig_royale && padDone) ejectFromPad(body, padDone, "Cashed out. Move along.");
        }
    }
}

// Vaults with a live cash-out in progress. Bullets fizzle inside these.
function occupiedVaults() {
    const out = [];
    for (const v of getVaults()) {
        const d = v._depositor;
        if (d && !d.isDead?.() && d.vaultDeposit) out.push(v);
    }
    return out;
}

module.exports = { tick, snapshot, requestDeposit, requestCancel, depositFor, getVaults, occupiedVaults };
