

const gems = require('./gems.js');
const war = require('./war.js');
const milestones = require('./milestones.js');

const PAD_RADIUS   = 95;
const DEPOSIT_RATE = 300;
const PROGRESS_MS  = 50;
const PAD_EJECT_MS = 10_000;      // idle time on the pad before a kick
const CASHED_LOCK_MS = 20_000;    // one visit per deposit
// The raid pad is drawn as a flat-topped octagon 1.15x the pad radius; the
// collision uses the same shape so the door is where it looks.
const padGeom = require('./padGeom.js');
const OCT_SCALE = padGeom.OCT.scale;
function insideOctagon(dx, dy, R) { return padGeom.insideNgon(dx, dy, R, 8); }
function onPadShape(v, dx, dy, extra = 0) {
    if (Config.dig_royale || v.rainbow) return padGeom.insideNgon(dx, dy, v.r * OCT_SCALE + extra, 8);
    const r = v.r + extra;
    return dx * dx + dy * dy < r * r;
}
const vaultKey = (pad) => 'vault:' + Math.round(pad.x) + ':' + Math.round(pad.y);

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

// Hull-to-rim exclusion, firm but not bouncy (see padGeom.keepOut).
function pushOut(body, pad, speed, now) {
    const clear = padGeom.keepOut(body, pad, 8, vaultKey(pad), 'expel');
    if (clear && body._vaultPush && body._vaultPush.pad === pad) body._vaultPush = null;
    return clear;
}

function ejectFromPad(body, pad, msg, lockMs = 5000) {
    if (!body || body.isDead?.()) return;
    body._vaultPush = { pad, until: Date.now() + 4000 };
    body._padHold = null;
    padGeom.keepOut(body, pad, 8, vaultKey(pad), 'expel');   // a steady shove, no snap
    body._vaultPadSince = 0;
    // Kicked out means out: no re-entry for 5s so the pad can't be
    // instantly re-camped. Scoped to THIS pad - a vault kick never locks
    // some other pad.
    body._padReentryUntil = Date.now() + lockMs;
    body._padReentryPad = pad;
    if (msg) { try { body.sendMessage(msg + " You can come back in " + Math.round(lockMs / 1000) + " seconds."); } catch { /* */ } }
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
                try { body.sendMessage("Someone's already using this vault. One at a time."); } catch { /* */ }
            }
            return false;
        }
    }
    const total = Math.min(amount, carried);
    body.vaultDeposit = {
        remaining: total,
        total,
        spill: (body.vaultDeposit && body.vaultDeposit.spill) || 0,
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
    // Drop locks held by bodies that left the world without a release
    // (destroyed alive). A live deposit always carries its deposit object.
    for (const v of list) {
        const d = v._depositor;
        if (d && (d.isGhost || d.isDead?.() || !d.vaultDeposit)) v._depositor = null;
    }
    // BR lobby/idle: playground only - no banking until scatter.
    if (Config.dig_royale) {
        try {
            if (require('../gamemodes/scripts/dig_royale.js').isLobbyPhase()) {
                for (const actor of actors) {
                    const body = actorBody(actor);
                    if (!body || body.isGhost) continue;
                    let on = false;
                    if (!body.isDead()) {
                        for (const v of list) {
                            if (onPadShape(v, body.x - v.x, body.y - v.y)) { on = true; break; }
                        }
                    }
                    body.onVaultPad = on;
                    body.vaultOnPad = false;
                }
                return;
            }
        } catch { /* fall through */ }
    }
    const now = Date.now();
    if (Config.dig_royale) {
        for (const v of list) v._onPad = [];
        for (const actor of actors) {
            const body = actorBody(actor);
            if (!body || body.isGhost || body.isDead?.()) continue;
            for (const v of list) {
                if (onPadShape(v, body.x - v.x, body.y - v.y)) { v._onPad.push(body); break; }
            }
        }
        for (const v of list) {
            const on = v._onPad || [];
            const humansOn = on.filter(b => !!b.socket);
            // A human always outranks a bot for the pad.
            const eligible = (b) => b && on.includes(b) && (b.socket || !humansOn.length);
            let keep = null;
            if (eligible(v._depositor)) keep = v._depositor;
            else if (eligible(v._occupant)) keep = v._occupant;
            else keep = humansOn[0] || on[0] || null;
            v._occupant = keep;
            for (const body of on) {
                if (body === keep) continue;
                cancelDeposit(body, !!body.socket);
                if (!body._vaultPush || body._vaultPush.pad !== v) {
                    ejectFromPad(body, v, body.socket ? "Someone's already in this vault. One at a time." : "");
                } else {
                    pushOut(body, v, 9, now);
                }
            }
        }
    }
    for (const actor of actors) {
        const body = actorBody(actor);
        if (!body || body.isGhost) continue;
        if (body.isDead()) {
            // Close the client panel too, or it stays open after respawn.
            if (body.vaultOnPad && body.socket) body.socket.talk('VU', 0);
            body.vaultOnPad = false;
            body.onVaultPad = false;
            if (body.vaultDeposit || body._vaultSite) {
                cancelDeposit(body, !!body.socket);
                if (body.socket) body.socket.talk('VP', 0, 0);
            } else cancelDeposit(body, false);
            body._vaultPadSince = 0;
            continue;
        }

        let pad = null;
        for (const v of list) {
            if (!Config.dig_royale && v.team !== body.team) continue;
            if (onPadShape(v, body.x - v.x, body.y - v.y)) { pad = v; break; }
        }

        const was = !!body.vaultOnPad;
        body.vaultOnPad = !!pad;
        body.onVaultPad = !!pad;
        // 5s no re-entry after a kick: hard deny, parked hull-to-edge every
        // tick. Touch (hull overlap) counts, not just center-inside, so the
        // nose can never get in and the timer restarts cleanly next visit.
        let denyPad = pad;
        if (!denyPad) {
            const br = body.realSize || 60;
            for (const v of list) {
                if (!Config.dig_royale && v.team !== body.team) continue;
                if (onPadShape(v, body.x - v.x, body.y - v.y, br)) { denyPad = v; break; }
            }
        }
        if (denyPad && body._padReentryUntil && now < body._padReentryUntil &&
            (!body._padReentryPad || body._padReentryPad === denyPad)) {
            cancelDeposit(body, !!body.socket);
            // still rolling off after a kick: keep shoving until the hull is
            // clear; only then is the rim a wall (a wall now would snap the
            // half-out hull to the edge)
            if (body._vaultPush && body._vaultPush.pad === denyPad) pushOut(body, denyPad, 9, now);
            else padGeom.keepOut(body, denyPad, 3, vaultKey(denyPad), true);
            body._vaultPadSince = 0;
            body.vaultOnPad = false;
            body.onVaultPad = false;
            if (was && body.socket) { body.socket.talk('VU', 0); cancelDeposit(body); }
            continue;
        }
        if (pad && !body._vaultPadSince) body._vaultPadSince = now;
        if (Config.dig_royale) {
            if (pad && !was) { body._vaultPadSince = now; body._vaultIdleSince = now; }
            // The pad is a safe room: the clock only runs while you stand
            // there doing nothing. A running deposit always finishes.
            if (pad && body.vaultDeposit) body._vaultIdleSince = now;
            if (!pad) {
                body._vaultPadSince = 0;
                if (body._vaultPush && now > body._vaultPush.until) body._vaultPush = null;
                if (was) cancelDeposit(body, !!body.socket);
            } else if (!body.vaultDeposit && body._vaultIdleSince && now - body._vaultIdleSince > PAD_EJECT_MS) {
                ejectFromPad(body, pad, "No camping on the vault.");
                continue;
            } else if (body.vaultDeposit && body._vaultSite && body._vaultSite !== pad) {
                // Walked to a different pad mid-deposit: move the lock or stop.
                if (!claimPad(pad, body)) { cancelDeposit(body, !!body.socket); continue; }
            } else if (body.vaultDeposit && !body._vaultSite) {
                if (!claimPad(pad, body)) { cancelDeposit(body, !!body.socket); continue; }
            }
            if (body._vaultPush) {
                if (body._vaultPush.pad !== pad) body._vaultPush = null;
                else if (pushOut(body, pad, 9, now)) continue;
            }
        }
        if (was !== body.vaultOnPad && body.socket) {
            body.socket.talk('VU', body.vaultOnPad ? 1 : 0);
            if (!body.vaultOnPad) cancelDeposit(body);
        }

        const d = body.vaultDeposit;
        if (!d) continue;

        // Storm chips do not interrupt a deposit (only bullets/ram do).
        // Dying in the storm still cancels through the dead branch.
        if (body.health.amount < d.lastHealth - 1e-3 && !body._inStorm) {
            cancelDeposit(body);
            continue;
        }
        d.lastHealth = body.health.amount;

        
        
        
        let rateMult = 1;
        if (body.socket) { try { rateMult = require('./shop.js').depositRateMult(body); } catch { /* */ } }
        d.spill = (d.spill || 0) + (DEPOSIT_RATE * rateMult * dtMs) / 1000;
        const chunk = Math.min(d.remaining, body.carriedGems | 0, Math.floor(d.spill));
        if (chunk <= 0) {
            if ((body.carriedGems | 0) <= 0 || d.remaining <= 0) cancelDeposit(body);
            continue;
        }
        d.spill -= chunk;
        d.remaining -= chunk;
        body.carriedGems = Math.max(0, (body.carriedGems | 0) - chunk);
        const banked = body.socket ? (body.socket.gemBanked || 0) : (body.botBanked || 0);
        // deep pockets pays a premium at the vault
        const credit = chunk * ((global.royaleMods && global.royaleMods.bankMult) || 1);
        if (body.isBot) body.botGemsBanked = (body.botGemsBanked || 0) + credit;
        setBanked(body, banked + credit);
        war.add(body.team, credit);
        milestones.checkBanked(body);
        if (Config.dig_royale) {
            try { require('../gamemodes/scripts/dig_royale.js').onBanked(body, credit); } catch { /* */ }
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
            if (Config.dig_royale && padDone) ejectFromPad(body, padDone, "Cashed out. Make room for the next miner.", CASHED_LOCK_MS);
        }
    }
}

module.exports = { tick, snapshot, requestDeposit, requestCancel, depositFor, getVaults, cancelDeposit, insideOctagon, onPadShape, OCT_SCALE };
