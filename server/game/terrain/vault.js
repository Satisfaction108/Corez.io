const gems = require('./gems.js');
const war = require('./war.js');
const milestones = require('./milestones.js');

const PAD_RADIUS   = 95;
// Round 10 (Oct 2026): banking is quick for everyone. At least BANK_RATE gems a
// second, and no deposit takes longer than BANK_MAX_S (8,000 banks in 3 s).
// Damage still cuts it. ROYALE_BANK_RATE=300 ROYALE_BANK_MAX_S=0 is the old pace.
const envNum = (k, d) => { const v = parseFloat(process.env[k]); return Number.isFinite(v) && v >= 0 ? v : d; };
const DEPOSIT_RATE = envNum('ROYALE_BANK_RATE', 1200) || 300;
const BANK_MAX_S = envNum('ROYALE_BANK_MAX_S', 3);
// gems per second for a deposit of `total` (same rule at vaults and bases)
function depositRate(total) {
    const t = Math.max(0, +total || 0);
    return Math.max(DEPOSIT_RATE, BANK_MAX_S > 0 ? t / BANK_MAX_S : 0);
}
const PROGRESS_MS  = 50;
// Stay limits doubled and re-entry waits halved on Oct 5 2026 (owner)
const PAD_EJECT_MS = 20_000;      // idle time on the pad before a kick (nothing to bank; was 10 s)
const PAD_EJECT_CARRY_MS = 50_000; // idle with a bankable satchel: time to pick an amount (was 25 s)
const CAMP_WARN_MS = 4_000;       // the heads-up before an idle kick
// Banking is by the vault panel (Bank all) for everyone again (Oct 5 2026
const AUTO_BANK_MS = 300;
const AUTO_BANK_RETRY_MS = 1500;
// A crown in the final minute (body.crownLocked) banks like anyone, but the vault
const CROWN_IDLE_MS = 3000;       // (was 1.5 s)
const CROWN_PAD_MS = 20_000;      // (was 10 s)
const CROWN_NO_HIDE = "A crown can't hide on the vault.";
const REENTRY_MS = 2500;          // after a kick, before the same vault lets you back on (was 5 s)
const CASHED_LOCK_MS = 10_000;    // one visit per deposit (was 20 s)
// The raid pad is drawn as a flat-topped octagon 1.15x the pad radius; the
// collision uses the same shape.
const padGeom = require('./padGeom.js');
const OCT_SCALE = padGeom.OCT.scale;
let _dustHooks = null;
function dustHooks() { return _dustHooks || (_dustHooks = require('../../accounts/game/dustHooks.js')); }

// Round 9 timed shield (also the quick-death respawn shield in dig_royale)
const POST_BANK_SHIELD_MS = process.env.ROYALE_BANK_SHIELD === '0' ? 0 : 3000;
function grantTimedShield(body, ms, t = Date.now()) {
    if (!body || !(ms > 0) || body.isDead?.()) return false;
    body.invuln = true;
    body.spawnGraceUntil = Math.max(body.spawnGraceUntil || 0, t + ms);
    body.shieldEndAt = Math.max(body.shieldEndAt || 0, t + ms);
    body.shootEndsShield = true;
    return true;
}
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

// Compact list for the TG snapshot.
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

// What a twist (Deep Pockets) paid on top of the satchel during a deposit: one
function flushPremium(body, d) {
    const n = d ? Math.round(d.premium || 0) : 0;
    if (d) d.premium = 0;
    if (!(n > 0) || !body || !body.socket) return;
    const pct = Math.round((d.premiumMult || 1) * 100);
    let name = "vault bonus";
    try { const m = global.royaleMods; if (m && m.name) name = m.name; } catch { /* */ }
    try { body.socket.talk('KC', 'bankpop', name + " " + pct + "%", n, 1); } catch { /* */ }
}

function cancelDeposit(body, notify = true) {
    if (!body || !body.vaultDeposit) { if (body) releasePad(body); return; }
    flushPremium(body, body.vaultDeposit);
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

// "2.5 seconds", "10 seconds"
function secondsText(ms) {
    const s = Math.round(ms / 100) / 10;
    return (Number.isInteger(s) ? String(s) : s.toFixed(1)) + (s === 1 ? " second" : " seconds");
}
function ejectFromPad(body, pad, msg, lockMs = REENTRY_MS) {
    if (!body || body.isDead?.()) return;
    body._vaultPush = { pad, until: Date.now() + 4000 };
    body._padHold = null;
    padGeom.keepOut(body, pad, 8, vaultKey(pad), 'expel');   // a steady shove, no snap
    body._vaultPadSince = 0;
    // no re-entry for lockMs, scoped to this pad only
    body._padReentryUntil = Date.now() + lockMs;
    body._padReentryPad = pad;
    if (msg) { try { body.sendMessage(msg + " You can come back in " + secondsText(lockMs) + "."); } catch { /* */ } }
}

const MIN_DEPOSIT = 15;

// fairPlay.js: bank cover (the same for everyone)
let _fair = null;
function fairPlay() { return _fair || (_fair = require('./fairPlay.js')); }

// How long a body may sit on a vault without a deposit running before the
function campLimitMs(body) {
    const carried = (body && body.carriedGems) | 0;
    if (body && body.crownLocked) return CROWN_IDLE_MS;
    if (carried >= MIN_DEPOSIT) return PAD_EJECT_CARRY_MS;
    return PAD_EJECT_MS;
}

// > true when the body was kicked off the pad
function campTick(body, pad, now) {
    const since = body._vaultIdleSince;
    if (!since) return false;
    const limit = campLimitMs(body);
    const idle = now - since;
    if (idle > limit) {
        ejectFromPad(body, pad, body.crownLocked ? CROWN_NO_HIDE : "No camping on the vault.");
        return true;
    }
    if (body.crownLocked) return false;   // too short for a heads-up
    if (idle > limit - CAMP_WARN_MS && body._campWarnFor !== since && body.socket) {
        body._campWarnFor = since;
        const carried = body.carriedGems | 0;
        try {
            body.sendMessage(carried >= MIN_DEPOSIT
                ? "Bank your gems or move on. You'll be moved off the vault in " + Math.round(CAMP_WARN_MS / 1000) + " seconds."
                : "Vaults are for banking, so you'll be moved off this one in " + Math.round(CAMP_WARN_MS / 1000) + " seconds.");
        } catch { /* */ }
    }
    return false;
}

// Only a final-minute crown banks without the panel (it has no time for it)
function autoBankDue(body, pad, now) {
    if (!body.crownLocked) return false;
    if ((body.carriedGems | 0) < MIN_DEPOSIT) return false;
    if (body._vaultPush && body._vaultPush.pad === pad) return false;
    if (!body._vaultPadSince || now - body._vaultPadSince < AUTO_BANK_MS) return false;
    return now - (body._autoBankTry || 0) >= AUTO_BANK_RETRY_MS;
}

function actorBody(actor) {
    return actor && actor.body ? actor.body : actor;
}

function setBanked(body, amount) {
    amount = Math.max(0, amount);
    if (body.socket) {
        body.socket.gemBanked = amount;
        try { require('./bank.js').fixKept(body.socket); } catch { /* */ }
    } else body.botBanked = amount;
    body.bankedGems = amount;
    return amount;
}

// a refused deposit always says why (a silent no reads as a broken button)
function refuse(body, msg) {
    const t = Date.now();
    if (t - (body._depositNoAt || 0) < 1500) return false;
    body._depositNoAt = t;
    try { body.sendMessage(msg); } catch { /* */ }
    return false;
}
function depositFor(body, amount) {
    if (!body || body.isDead()) return false;
    if (!body.vaultOnPad) return refuse(body, "Get onto the vault to bank.");
    // asking to bank is not camping, even when the answer is no
    if (Config.dig_royale) body._vaultIdleSince = Date.now();
    // the Crown Contest's sudden death: a crown can't bank
    let crownNo = null;
    try { crownNo = require('./crowns.js').bankBlocked(body); } catch { /* */ }
    if (crownNo) return refuse(body, crownNo);
    amount = Math.floor(amount);
    const carried = body.carriedGems | 0;
    if (carried < MIN_DEPOSIT) return refuse(body, "You need at least " + MIN_DEPOSIT + " gems to bank.");
    if (!(amount > 0)) amount = carried;
    if (Config.dig_royale) {
        let pad = null;
        // same shape tick() uses to open the panel (the octagon reaches past v.r)
        for (const v of getVaults()) {
            if (onPadShape(v, body.x - v.x, body.y - v.y)) { pad = v; break; }
        }
        if (!pad) return refuse(body, "Drive onto the middle of the vault to bank.");
        if (!claimPad(pad, body)) {
            const t = Date.now();
            if (t - (body._vaultBusyAt || 0) > 3000) {
                body._vaultBusyAt = t;
                try { body.sendMessage("Someone else is already using this vault, so wait your turn."); } catch { /* */ }
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

// Gems straight into a bank without a deposit (the Core's payout): counted
// exactly like vault banking (score, stats, milestones, quests, the war bar)
function creditBank(body, amount) {
    amount = Math.floor(amount);
    if (!body || !(amount > 0)) return 0;
    const banked = body.socket ? (body.socket.gemBanked || 0) : (body.botBanked || 0);
    if (body.isBot) body.botGemsBanked = (body.botGemsBanked || 0) + amount;
    setBanked(body, banked + amount);
    war.add(body.team, amount);
    milestones.checkBanked(body, amount);
    if (Config.dig_royale) {
        try { dustHooks().onBankedDirect(body, amount); } catch { /* */ }
        try { require('../gamemodes/scripts/dig_royale.js').onBanked(body, amount); } catch { /* */ }
        try { dustHooks().onBankDone(body); } catch { /* */ }
    }
    try { gems.talkGems(body, 0); } catch { /* */ }
    return amount;
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
    // drop locks held by bodies that left the world without releasing
    for (const v of list) {
        const d = v._depositor;
        if (d && (d.isGhost || d.isDead?.() || !d.vaultDeposit)) v._depositor = null;
    }
    // no banking in the BR lobby
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
            // a human always outranks a bot for the pad
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
                    ejectFromPad(body, v, body.socket ? "Someone else is already in this vault, so wait your turn." : "");
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
            // close the client panel, or it stays open after respawn
            if (body.vaultOnPad && body.socket) body.socket.talk('VU', 0);
            body.vaultOnPad = false;
            body.onVaultPad = false;
            if (body.vaultDeposit || body._vaultSite) {
                cancelDeposit(body, !!body.socket);
                if (body.socket) body.socket.talk('VP', 0, 0);
            } else cancelDeposit(body, false);
            body._vaultPadSince = 0;
            body._bankedVisit = false;
            body._fpBank = 0; body._bankCover = 0; body._bankCoverAt = 0;
            continue;
        }

        let pad = null;
        for (const v of list) {
            if (!Config.dig_royale && v.team !== body.team) continue;
            if (onPadShape(v, body.x - v.x, body.y - v.y)) { pad = v; break; }
        }
        // bank cover (fairPlay.js): slightly softer shots while banking and just after
        if (Config.dig_royale) {
            try { fairPlay().bankStamp(body, body.vaultDeposit ? (body._vaultSite || pad) : null, now, list); } catch { /* */ }
        }

        const was = !!body.vaultOnPad;
        body.vaultOnPad = !!pad;
        body.onVaultPad = !!pad;
        // Re-entry lock after a kick: hull overlap counts, not just the
        // centre, so the nose never gets in.
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
            // clear, only then treat the rim as a wall (avoids a snap)
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
            // the idle clock only runs while not depositing
            if (pad && body.vaultDeposit) body._vaultIdleSince = now;
            if (!pad) {
                // off the vault (hull clear) after banking this visit: the 3 s vault shield
                if (body._bankedVisit && !denyPad) {
                    body._bankedVisit = false;
                    if (grantTimedShield(body, POST_BANK_SHIELD_MS, now) && body.socket) body.socket.talk('VU', 2);
                }
                body._vaultPadSince = 0;
                if (body._vaultPush && now > body._vaultPush.until) body._vaultPush = null;
                if (was) cancelDeposit(body, !!body.socket);
            } else if (!body.vaultDeposit) {
                if (autoBankDue(body, pad, now)) {
                    body._autoBankTry = now;
                    depositFor(body, body.carriedGems | 0);
                }
                if (!body.vaultDeposit && campTick(body, pad, now)) continue;
            } else if (body._vaultSite && body._vaultSite !== pad) {
                // walked to a different pad mid-deposit: move the lock or stop
                if (!claimPad(pad, body)) { cancelDeposit(body, !!body.socket); continue; }
            } else if (!body._vaultSite) {
                if (!claimPad(pad, body)) { cancelDeposit(body, !!body.socket); continue; }
            }
            // a final-minute crown: banked, then on its way
            if (pad && body.crownLocked && body._vaultPadSince && now - body._vaultPadSince > CROWN_PAD_MS && !body._vaultPush) {
                ejectFromPad(body, pad, CROWN_NO_HIDE);
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
        // a crown banks in the final minute too: crowns.js BANK_IN_SD)

        // storm damage doesn't interrupt a deposit
        if (body.health.amount < d.lastHealth - 1e-3 && !body._inStorm) {
            cancelDeposit(body);
            if (body.socket && global.royaleAch) global.royaleAch.onDepositCut(body);
            continue;
        }
        d.lastHealth = body.health.amount;

        let rateMult = 1;
        if (body.socket) { try { rateMult = require('./shop.js').depositRateMult(body); } catch { /* */ } }
        d.spill = (d.spill || 0) + (depositRate(d.total) * rateMult * dtMs) / 1000;
        const chunk = Math.min(d.remaining, body.carriedGems | 0, Math.floor(d.spill));
        if (chunk <= 0) {
            if ((body.carriedGems | 0) <= 0 || d.remaining <= 0) cancelDeposit(body);
            continue;
        }
        d.spill -= chunk;
        d.remaining -= chunk;
        const carriedBefore = body.carriedGems | 0;
        body.carriedGems = Math.max(0, carriedBefore - chunk);
        // gemdust leaves with its share of the satchel, at full efficiency
        if (Config.dig_royale) { try { dustHooks().onSatchelOut(body, chunk, carriedBefore, 1); } catch { /* */ } }
        const banked = body.socket ? (body.socket.gemBanked || 0) : (body.botBanked || 0);
        // deep pockets pays a premium at the vault
        const bankMult = (global.royaleMods && global.royaleMods.bankMult) || 1;
        const credit = chunk * bankMult;
        // the twist's premium gets its own labelled pop when the deposit ends
        if (bankMult !== 1) { d.premium = (d.premium || 0) + (credit - chunk); d.premiumMult = bankMult; }
        if (body.isBot) body.botGemsBanked = (body.botGemsBanked || 0) + credit;
        setBanked(body, banked + credit);
        if (Config.dig_royale && body.socket && POST_BANK_SHIELD_MS > 0 && credit > 0) body._bankedVisit = true;
        war.add(body.team, credit);
        milestones.checkBanked(body, credit);
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
            flushPremium(body, d);
            body.vaultDeposit = null;
            if (body.socket && global.royaleAch) global.royaleAch.onDeposit(body, d.total);
            releasePad(body);
            body.carriedGems = body.carriedGems | 0;
            const banked = body.socket ? (body.socket.gemBanked || 0) : (body.botBanked || 0);
            setBanked(body, Math.round(banked));
            gems.updateSatchel(body);
            if (Config.dig_royale) { try { dustHooks().onBankDone(body); } catch { /* */ } }
            if (Config.dig_royale && padDone) ejectFromPad(body, padDone, "You cashed out! Make room for the next miner.", CASHED_LOCK_MS);
        }
    }
}

module.exports = { DEPOSIT_RATE, BANK_MAX_S, depositRate, grantTimedShield, POST_BANK_SHIELD_MS, flushPremium, MIN_DEPOSIT, PAD_EJECT_MS, PAD_EJECT_CARRY_MS, AUTO_BANK_MS, CROWN_IDLE_MS, CROWN_PAD_MS, REENTRY_MS, CASHED_LOCK_MS, secondsText, campLimitMs, creditBank, tick, snapshot, requestDeposit, requestCancel, depositFor, getVaults, cancelDeposit, insideOctagon, onPadShape, OCT_SCALE };
