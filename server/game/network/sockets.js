let smokeAbil = null;   // terrain/abilities.js, loaded on the first smoked tank in a view
let crypto = require("crypto"),
    net = require('net'),
    fs = require("fs");
    PERMABAN_FILE = "./permabans.json";
let bans = global.bans || (global.bans = []);
// How much queueing past the base round trip a client may build up before
// snapshots are skipped instead of sent.
const FLOW_SLACK_MS = +process.env.FLOW_SLACK_MS || 250;
let permBans = global.permBans || (global.permBans = []);
global.chatID = 0;
const { clientIp } = require("../../lib/clientIp.js");
const accountBridge = require("../../accounts/game/bridge.js");
const activity = require("./activity.js");
const { unpackMove } = require("../../lib/touchMove.js");

// Same rule as the accounts config: NODE_ENV, or a real public hostname.
function isProduction() {
    const host = String(process.env.PUBLIC_HOST || "");
    return process.env.NODE_ENV === "production" ||
        (!!host && !/^(localhost|127\.0\.0\.1|\[?::1\]?)(:\d+)?$/i.test(host));
}

function livingSpectateList() {
    const out = [], stormed = [];
    // Raid: tanks in the storm are about to die and each death would hop the
    // camera again during the final hold, so watch the safe circle.
    let storm = null;
    if (Config.dig_royale) { try { storm = require('../terrain/storm.js'); } catch { storm = null; } }
    for (const e of entities.values()) {
        if (!e || e.isGhost) continue;
        if (!(e.isPlayer || e.isBot)) continue;
        if (typeof e.isDead === "function" && e.isDead()) continue;
        if (storm && storm.inStorm(e.x, e.y)) stormed.push(e);
        else out.push(e);
    }
    return out.length ? out : stormed;
}

// Where the camera parks when there is nobody to watch: the safe circle.
function spectateParkSpot() {
    if (!Config.dig_royale) return null;
    try {
        const st = require('../terrain/storm.js').snapshot();
        if (st && st.a && isFinite(st.cx) && isFinite(st.cy)) return { x: st.cx, y: st.cy };
    } catch { /* */ }
    return null;
}

// Nearest living combatant to a point: the auto-hop when a spectate target dies.
function nearestSpectate(socket, x, y) {
    let best = null, bestD = Infinity;
    for (const e of livingSpectateList()) {
        if (e === socket.spectateEntity) continue;
        const dx = e.x - x, dy = e.y - y;
        // real players first: a bot counts as 3x as far away
        const d = (dx * dx + dy * dy) * (e.socket ? 1 : 9);
        if (d < bestD) { bestD = d; best = e; }
    }
    socket.spectateEntity = best || livingSpectateList()[0] || null;
}

function cycleSpectate(socket, dir) {
    const list = livingSpectateList();
    if (!list.length) {
        socket.spectateEntity = null;
        return;
    }
    let i = list.findIndex(e => e === socket.spectateEntity);
    if (i < 0) {
        socket.spectateEntity = list[0];
        return;
    }
    if (!dir) return;
    i = (i + (dir < 0 ? -1 : 1) + list.length) % list.length;
    socket.spectateEntity = list[i];
}

// Walk a killer (bullet/drone/tank) up to the living player or bot to follow.
// strict: no stand-in when the killer was not a tank (a boss, the storm), so
// the death cam picks the tank nearest the corpse instead of a random one.
function livingSpectateTarget(killers, strict = false) {
    if (!Array.isArray(killers)) return strict ? null : (livingSpectateList()[0] || null);
    for (const e of killers) {
        if (!e) continue;
        let root = e;
        for (let i = 0; i < 8 && root.master && root.master !== root; i++) root = root.master;
        if (typeof root.isDead === "function" && root.isDead()) continue;
        if (root.isPlayer || root.isBot) return root;
    }
    return strict ? null : (livingSpectateList()[0] || null);
}

// The colour a player sees their own tank (and HUD) in. Tutorial learners all
// share TEAM_BLUE internally but each wears a Dig Royale palette colour.
function ownTankColor(body) {
    if (Config.tutorial && body && body.socket && body.socket._tutColor != null) return body.socket._tutColor;
    return !Config.random_body_colors && (Config.groups || (Config.mode == 'ffa' || Config.mode == 'clan' && !Config.tag)) ? 10 : global.getTeamColor(body.team);
}

// Dead-link detection. A sleeping laptop or a dropped network leaves the TCP
// connection half-open for minutes, so every socket gets a websocket ping
// every PING_EVERY_MS. No pong and no packet for linkWatch.deadAfter (longer
// for a tab that said it went hidden): the socket is terminated (not closed:
// a close handshake to a dead peer waits another 30 s), which runs the normal
// drop path at once (the tank leaves the world, the raid is held for its
// resume window).
const linkWatch = require("../../lib/linkWatch.js");
const PING_EVERY_MS = linkWatch.PING_EVERY_MS;

class socketManager {
    constructor(parent) {
        this.permissionsDict = Object.create(null);
        this.clients = parent.clients;
        this.gamemode = parent.gamemode;
        this.players = [];
        this.disconnections = [];
        this.playersReceived = [];
        this.bans = [];
        this.linkWatch = setInterval(() => this.checkLinks(), 1000);
        if (this.linkWatch.unref) this.linkWatch.unref();

        for (let entry of require("../permissions.js")) {
            // Skip unset env tokens (they would register under the key "undefined"),
            // short keys, and the .env.example placeholders.
            const key = typeof entry.key === "string" ? entry.key.trim() : "";
            if (key.length < 16 || /^change_me/i.test(key)) continue;
            this.permissionsDict[key] = entry;
        }
    };

    checkLinks() {
        const t = Date.now();
        for (const socket of this.clients.slice()) {
            if (!socket || socket.readyState !== socket.OPEN || typeof socket.ping !== "function") continue;
            if (linkWatch.isDead(socket, t)) {
                util.warn("No answer from a client for " + Math.round((t - socket._seenAt) / 1000) + " s" + (socket._tabHiddenAt ? " (tab hidden)" : "") + ". Dropping the link.");
                socket._deadLink = true;
                try { socket.terminate(); } catch (e) { /* already gone */ }
                continue;
            }
            if (t - (socket._pingAt || 0) >= PING_EVERY_MS) {
                socket._pingAt = t;
                try { socket.ping(); } catch (e) { /* closing */ }
            }
        }
    }

    broadcast(message) {
        // Tutorial: a room-wide announcement is by definition about somebody
        // else's arena, and nothing on the training ground should ever be.
        if (Config.tutorial) return;
        for (let i = 0; i < this.clients.length; i++) {
            this.clients[i].talk("m", Config.popup_message_duration, message);
        }
    };
    broadcastRoom() {
        for (let i = 0; i < this.clients.length; i++) {
            this.clients[i].talk(
                'r',
                global.gameManager.room.width,
                global.gameManager.room.height,
                JSON.stringify(global.gameManager.room.setup.map(x => x.map(t => {
                    return {
                        color: t.color,
                        image: t.image ?? false,
                    }
                }))),
            );
        }
    };
    ban(socket, reason) {
        let time = Date.now();
        util.warn((reason || "No reason given.") + " Banning.");

        let s = this.clients.filter((c) => c.ip === socket.ip);

        for (let i = 0; i < s.length; i++) {
            s[i].lastWords("K");
            if (s[i].player && s[i].player.body) {
                s[i].player.body.kill();
                s[i].player.body.destroy();
            }
            if (s[i].readyState === s[i].OPEN) {
                setTimeout(() => {
                    s[i].terminate();
                }, 100);
            }
        }
        bans.push({
            id: Math.random().toString(36).substr(2, 9),
            ip: socket.ip,
            time: time,
            name: (socket.player && socket.player.body && socket.player.body.name) || "Unnamed",
            reason: reason,
        });
    }

    permaban(socket, reason) {
        let time = Date.now();
        util.warn((reason || "No reason given.") + " Permanent Banning.");

        let s = this.clients.filter((c) => c.ip === socket.ip);
        for (let i = 0; i < s.length; i++) {
            s[i].lastWords("K");
            if (s[i].player && s[i].player.body) {
                s[i].player.body.kill();
                s[i].player.body.destroy();
            }
            if (s[i].readyState === s[i].OPEN) {
                setTimeout(() => {
                    s[i].terminate();
                }, 100);
            }
        }

        permBans.push({
            ip: socket.ip,
            time: time,
            name: (socket.player && socket.player.body && socket.player.body.name) || "Unnamed",
            reason: reason,
        });

        fs.writeFileSync(PERMABAN_FILE, JSON.stringify(permBans, null, 2));
    }
    chatLoop() {

        let now = Date.now();
        for (let i in chats) {
            chats[i].messages = chats[i].messages.filter((chat) => chat.expires > now);
        }

        for (let view of global.gameManager.views) {
            let nearby = view.getNearby(),
            array = [];

            const viewTeam = view.socket.player && view.socket.player.body
                ? view.socket.player.body.team
                : (view.socket.player ? view.socket.player.team : undefined);
            for (let entity of nearby.values()) {
                let id = entity.id;
                if (chats[id]) {
                    array.push({ id: id, messages: [] });
                    let index = array.length - 1;
                    // blocked accounts (either way) never see each other's chat
                    if (entity.accountId && accountBridge.chatHidden(view.socket, entity)) continue;
                    for (let chat of chats[id].messages) {
                        if (chat.team != null && chat.team !== viewTeam) continue;
                        array[index].messages.push({ text: chat.team != null ? "[TEAM] " + chat.message : chat.message, id: chat.id });
                    }
                }
            }
            if (view.socket.status.disablechat) {
                view.socket.talk("CHAT_MESSAGE_ENTITY", JSON.stringify(array.map(o => {return {id: o.id, messages: []}})));
            } else view.socket.talk("CHAT_MESSAGE_ENTITY", JSON.stringify(array));
        }
    }

    close(socket) {

        let player = socket.player,
            index = this.players.indexOf(player);

        if (socket._spawnLoop) {
            try { clearInterval(socket._spawnLoop); } catch { /* */ }
            socket._spawnLoop = null;
        }
        // an account kicked for a newer session already saved its resume
        if (Config.dig_royale && player && !socket._drCleaned) {
            try {
                require('../gamemodes/scripts/dig_royale.js').disconnectCleanup(socket, player.body || null);
            } catch { /* */ }
        }
        try { accountBridge.onClose(socket); } catch { /* */ }
        if (Config.royale_duos) { try { require('../duo/duoRaid.js').onClose(socket); } catch (e) { console.error('[DUO] close', e && e.message); } }

        if (socket.group) groups.removeMember(socket);

        if (index != -1) {

            if (player.body != null) {
                if (player.body.underControl) {
                    player.body.giveUp(player);
                }
                if (socket.status.transferred) {
                    player.body.invuln = false;
                    player.body.destroy();
                } else {
                    // disconnecting = dying: kill the tank so no new connection can inherit it.
                    if (Config.clan_wars) Config.clan_wars_ft.remove(player.body);
                    // destroy() below removes the body before its 'dead' event can run, so the
                    // satchel drops here (saveResume leaves those gems on the body).
                    if (Config.dig_royale && (player.body.carriedGems | 0) > 0 && !player.body.isDead()) {
                        try { require('../terrain/gems.js').dropGemsOnDeath(player.body, []); } catch (e) { console.error('[RAID] disconnect drop', e && e.message); }
                    }
                    player.body.invuln = false;
                    player.body.kill();
                    player.body.destroy();
                }
            }

            util.log("[INFO]: " + (player.body ? `User ${player.body.name == "" ? "A unnamed player" : player.body.name}` : "A user without an entity") + " disconnected!");
            util.remove(this.players, index);
        } else {
            util.log("[INFO]: A player disconnected before entering the game.");
        }

        // util.remove(arr, -1) would evict someone else: sockets turned away
        // before they joined clients (bans, a newer tab winning) have no slot
        const viewIndex = global.gameManager.views.indexOf(socket.view);
        if (viewIndex !== -1) util.remove(global.gameManager.views, viewIndex);

        // Hand the learner's plot (and its scripted bots) back to the pool.
        if (Config.tutorial) require('../tutorialSession.js').releasePlot(socket);

        const clientIndex = this.clients.indexOf(socket);
        if (clientIndex === -1) return;
        util.remove(this.clients, clientIndex);
        if (!global.gameManager.parentPort) {
            for (let i = 0; i < global.servers.length; i++) {
                let server = global.servers[i];
                if (server.gameManager) server.players--;
            }
        } else {
            global.gameManager.parentPort.postMessage([true, global.gameManager.reportedPlayerCount()]);
        }
        util.log("[INFO]: The connection has closed. Views: " + global.gameManager.views.length + ". Clients: " + this.clients.length + ".");
    }
    incoming(message, socket) {

        let m = protocol.decode(message);

        let player = socket.player;

        if (m === null) {
            socket.kick("Malformed packet.");
            return 1;
        }

        if (socket.resolveResponse(m[0], m)) {
            return;
        }
        switch (m.shift()) {
            case 'k': {
                if (m.length > 1) { socket.kick('Ill-sized key request.'); return 1; }
                if (socket.status.verified) { socket.kick('Duplicate player spawn attempt.'); return 1; }
                socket.talk('w', true);
                if (m.length === 1) {
                    let key = m[0].toString().trim();
                    socket.permissions = this.permissionsDict[key];
                    // Never log the token itself: logs are not a secret store.
                    if (socket.permissions) {
                        util.log(`[INFO]: A socket was verified with a perk token (${socket.permissions.class}, ${socket.permissions.name}).`);
                    } else if (key) {
                        util.log(`[WARNING]: A socket failed to verify with a perk token.`);
                    }
                    socket.key = key;
                }
                socket.status.verified = true;
                if (this.clients.length == 1) {
                    util.log('[INFO]: ' + this.clients.length + ' client connected');
                } else {
                    util.log('[INFO]: ' + this.clients.length + ' clients connected');
                }
            } break;
            case 's': {
                // A death packet and the client's click can cross on the wire: accept the
                // request when the attached body is already dead or gone.
                const liveBody = socket.player?.body && !socket.player.body.isDead();
                if (!socket.status.deceased && liveBody) {
                    socket.kick('Trying to spawn while already alive.');
                    return 1;
                }
                socket.status.deceased = true;
                socket.status.readyToSpawn = true;
                if (Config.dig_royale) {
                    const dr = require('../gamemodes/scripts/dig_royale.js');
                    dr.requestPlay();
                    if (dr.canSpawn()) socket.royaleNeedClick = false;
                    else {
                        // Final storm: no spawns. Queue them watching instead; the spawn
                        // loop below drops them in when it lifts.
                        socket.royaleWantsSpectate = true;
                        if (!socket.spectateEntity || socket.spectateEntity.isDead?.()) {
                            cycleSpectate(socket, 0);
                        }
                    }
                    const stillLive = socket.player?.body && !socket.player.body.isDead();
                    if (stillLive) return 1;
                }
                if (!global.gameManager.webProperties.maxPlayers < 1 && this.clients.length > global.gameManager.webProperties.maxPlayers) return (
                    socket.talk("message", "This server is full, please rejoin later."),
                    socket.kick("Server full.")
                )
                let b = bans.find((ban) => ban.ip === socket.ip);
                if (b) {
                    socket.talk("temporaryban");
                    socket.kick("Temporarily banned player detected!");
                    return 1;
                  }
                let permB = permBans.find(
                  (bannedIP) => bannedIP.ip === socket.ip
                );
                if (permB) {
                    socket.talk("permanentban");
                    socket.permaban("Permanently banned player found!");
                  return 1;
                }

                if (m.length < 4) {
                    socket.kick("Ill-sized spawn request.");
                    return 1;
                }
                let name = m[0];
                let needsRoom = m[1];
                let autoLVLup = m[2];
                let transferbodyID = m[3];
                let incognitoMode = m[4];
                if (incognitoMode && Config.allow_incognito !== false) socket.status.incognito = true;
                if (global.gameManager.arenaClosed) {
                    if (needsRoom) {
                      socket.talk("message", "Arena closed. Try again in a few seconds.");
                      socket.terminate("Bad spawn while arena closed.");
                    } else socket.talk("m", 5_000, "Arena Closed.");
                    return;
                };

                if (typeof name != "string") { socket.kick("Bad spawn request. (name)"); return 1; }
                let nameBytes = 0;
                try { nameBytes = encodeURI(name).split(/%..|./).length; } catch { nameBytes = Infinity; }   // lone surrogate
                if (nameBytes > 48) { socket.kick("Shorten your name!"); return 1; }
                if (typeof m[1] !== "number") { socket.kick("Bad spawn request. (needsRoom)"); return 1; }
                if (typeof autoLVLup !== "number") { socket.kick("Bad spawn request. (autoLVLup)"); return 1; }
                if (typeof incognitoMode !== "number") { socket.kick("Bad spawn request. (incognito)"); return 1; }
                if (transferbodyID && typeof transferbodyID != "string") { socket.kick("Bad body transfer. (transferbodyID)"); return 1; }
                // Body transfer only exists for server travel; elsewhere an id
                // would let a client claim another player's travelling body.
                if (!Config.allow_server_travel) transferbodyID = "";
                if (transferbodyID) transferbodyID = transferbodyID.replace(name, "");

                name = name.replace(Config.banned_characters, '').replace(/\s+/g, ' ').trim();
                // accounts play under their username; guests get a cleaned name
                if (Config.dig_royale) name = accountBridge.resolveName(socket, name);

                if (needsRoom) {
                    if (Config.hidden) return socket.close();
                    this.newPlayer(socket);
                    socket.talk(
                        'R',
                        global.gameManager.room.width,
                        global.gameManager.room.height,
                        JSON.stringify(global.gameManager.room.setup.map(x => x.map(t => {
                            return {
                                color: t.color,
                                visibleOnBlackout: t.visibleOnBlackout,
                                image: t.image ?? false,
                            }
                        }))),
                        JSON.stringify(util.serverStartTime),
                        global.gameManager.roomSpeed,
                        JSON.stringify({
                            active: Config.blackout,
                            color: Config.blackout_fog,
                        }),
                        Config.arena_shape,
                    );
                    if (global.gameManager.terrainGrid) {
                        socket.talk(
                            'TG',
                            global.gameManager.terrainGrid.cols,
                            global.gameManager.terrainGrid.rows,
                            JSON.stringify(global.gameManager.terrainGrid.serialize()),

                            JSON.stringify(global.gameManager.terrainGrid.rockStateSnapshot()),

                            JSON.stringify(global.gameManager.terrainGrid.oreSnapshot()),

                            global.gameManager.terrainGrid.oreSalt,

                            JSON.stringify(require('../terrain/vault.js').snapshot()),

                            JSON.stringify(require('../terrain/outposts.js').snapshot()),

                            JSON.stringify(require('../terrain/coreChambers.js').snapshot()),
                            Config.dig_royale ? 1 : 0,
                            JSON.stringify(require('../terrain/shop.js').snapshot()),
                        );
                        if (Config.dig_royale || Config.tutorial) {
                            const shopMod = require('../terrain/shop.js');
                            socket.talk('SHC', JSON.stringify(shopMod.catalog()));
                            shopMod.talkState(socket);
                        }
                    }
                    return;
                }
                if (socket._spawnLoop) {
                    try { clearInterval(socket._spawnLoop); } catch { /* */ }
                }
                let loop = socket._spawnLoop = setInterval(() => {

                    if (!global.cannotRespawn && !global.gameManager.arenaClosed && socket.status.readyToSpawn) {
                        if (Config.dig_royale) {
                            const dr = require('../gamemodes/scripts/dig_royale.js');
                            // Duos: a lone filler waits here for a teammate (or a
                            // bot). Ahead of the spawn gates, so the queue runs
                            // through a final-storm lock or the between-raids wait.
                            if (Config.royale_duos && require('../duo/duoRaid.js').holdSpawn(socket, name)) return;
                            // Dead players stay dead until they click Play in lobby.
                            // The 20ms retry must not auto-spawn when a match rolls over.
                            if (!dr.canSpawn()) return;
                            if (socket.royaleNeedClick) return;
                            // Server-side backstop for the death wait (dig_royale RESPAWN_MS,
                            // from the death itself): no early drop however the client asks.
                            if (socket.royaleRespawnAt && Date.now() < socket.royaleRespawnAt) return;
                        }
                        clearInterval(loop);
                        if (socket._spawnLoop === loop) socket._spawnLoop = null;
                        let epackage = {};
                        epackage.name = name;
                        epackage.autoLVLup = autoLVLup;
                        epackage.transferbodyID = transferbodyID;

                        epackage.braindamagemode = false;
                        if (Config.brain_damage && name.toLowerCase().includes("brain damage")) {
                            epackage.braindamagemode = true;
                        }
                        this.initalizePlayer(epackage, socket);
                    }
                }, 20)
            } break;
            case 'S': {
                if (m.length !== 1) { socket.kick('Ill-sized sync packet.'); return 1; }

                let synctick = m[0];

                if (typeof synctick !== 'number') { socket.kick('Weird sync packet.'); return 1; }

                socket.talk('S', synctick, util.time());
            } break;
            case 'p': {
                if (m.length !== 1) { socket.kick('Ill-sized ping.'); return 1; }

                let ping = m[0];

                if (typeof ping !== 'number') { socket.kick('Weird ping.'); return 1; }

                socket.talk('p', ping.toFixed(1));
                socket.status.lastHeartbeat = util.time();
            } break;
            case 'vd': {
                if (m.length !== 1) { socket.kick("Ill-sized vault deposit."); return 1; }
                if (typeof m[0] !== "number" || !isFinite(m[0])) { socket.kick("Weird vault deposit."); return 1; }
                const vBody = socket.player && socket.player.body;
                // Tutorial: banking is its own lesson; other steps refuse it.
                // "bank:vault" / "bank:base" narrow it to the pad the step is about.
                if (Config.tutorial && vBody &&
                    !require('../tutorialSession.js').allows(vBody, 'bank', vBody.outpostOnPad ? 'base' : 'vault')) return;
                if (vBody && vBody.outpostOnPad) require('../terrain/outposts.js').requestDeposit(socket, m[0]);
                else require('../terrain/vault.js').requestDeposit(socket, m[0]);
            } break;
            case 'vc': {
                require('../terrain/vault.js').requestCancel(socket);
                require('../terrain/outposts.js').requestCancel(socket);
            } break;
            case "d": {

                if (m.length !== 1) {
                    socket.kick("Ill-sized downlink.");
                    return 1;
                }

                let time = m[0];

                if (typeof time !== "number") {
                    socket.kick("Bad downlink.");
                    return 1;
                }

                socket.status.receiving = 0;
                socket.camera.ping = util.time() - time;
                socket.camera.lastDowndate = util.time();
                // flow control bookkeeping, see gazeUpon
                const flow = socket.flow;
                while (flow.sent.length && flow.sent[0] <= time) flow.sent.shift();
                const rtt = util.time() - time;
                // Base RTT = the lowest sample of the last ~30 s (six 5 s buckets), not the
                // current sample: on a clogged link that is the queue itself. Capped so a
                // bad line can't widen it.
                if (rtt >= 0) {
                    const nowR = util.time(), b = Math.floor(nowR / 5000);
                    const mins = flow.rttMins || (flow.rttMins = []);
                    if (!mins.length || mins[mins.length - 1].b !== b) { mins.push({ b, v: rtt }); if (mins.length > 6) mins.shift(); }
                    else if (rtt < mins[mins.length - 1].v) mins[mins.length - 1].v = rtt;
                    let m = Infinity;
                    for (const x of mins) if (x.b > b - 6 && x.v < m) m = x.v;
                    flow.rttMin = Math.min(600, isFinite(m) ? m : rtt);
                    flow.rttMinAt = nowR;
                }
            } break;
            case "C": {

            // a fifth field is the touch stick's analog move (see unpackMove)
            if (m.length !== 4 && m.length !== 5) {
                socket.kick("Ill-sized command packet.");
                return 1;
            }

            let target = {
                    x: m[0],
                    y: m[1],
                },
                reverseTank = m[2],
                commands = m[3];

            if (
                typeof target.x !== "number" ||
                typeof target.y !== "number" ||
                typeof commands !== "number"
            ) {
                socket.kick("Weird downlink.");
                return 1;
            }
            if (commands > 255) {
                socket.kick("Malformed command packet.");
                return 1;
            }
            // real input (keys or buttons changed, the aim clearly moved):
            // the idle kick, ranked survival and bot protection read it.
            // Before the body check: the death card's idle kick reads it too.
            activity.noteCommand(socket, target.x, target.y, commands);

            if (player.body == null) return;

            if (!socket.player.body.eastereggs.braindamage) player.target = target;

            player.body.reverseTank = reverseTank;

            if (player.command != null) {
                player.command.up = commands & 1;
                player.command.down = (commands & 2) >> 1;
                player.command.left = (commands & 4) >> 2;
                player.command.right = (commands & 8) >> 3;
                player.command.lmb = (commands & 16) >> 4;
                player.command.mmb = (commands & 32) >> 5;
                player.command.rmb = (commands & 64) >> 6;
                player.command.sidearm = (commands & 128) >> 7;
                // touch sticks: full-circle direction and partial speed. Only
                // counts while a movement bit is down, so a stale value can't
                // keep a tank walking.
                const analog = m.length === 5 && (commands & 15) ? unpackMove(m[4]) : null;
                player.command.moveX = analog ? analog.x : 0;
                player.command.moveY = analog ? analog.y : 0;
                player.command.analog = !!analog;
                if (player.body && (player.body.royaleFrozen || (global.royaleInFall && global.royaleInFall(player.body)))) {
                    player.command.lmb = player.command.mmb = player.command.rmb = player.command.sidearm = 0;
                    player.command.up = player.command.down = player.command.left = player.command.right = 0;
                }
            }
            } break;
            case "#": {
                try {
                    runKeyCommand(socket, m);
                } catch (e) {
                    console.error(e);
                }
            } break;
            case "t": {

                if (m.length !== 2) {
                    socket.kick("Ill-sized toggle.");
                    return 1;
                }

                let tog = m[0];

                if (typeof tog !== "number") {
                    socket.kick("Weird toggle.");
                    return 1;
                }
                let sendMessage = m[1];

                let given = [
                    "autospin",
                    "autofire",
                    "override",
                    "autoalt",
                    "spinlock"
                ][tog];

                if (!given) {
                    socket.kick("Bad toggle.");
                    return 1;
                }

                if (player.command != null && player.body != null) {
                    player.command[given] = !player.command[given];

                    if (sendMessage) player.body.sendMessage(given.charAt(0).toUpperCase() + given.slice(1) + (player.command[given] ? " enabled." : " disabled."));
                }
            } break;
            case "U": {
                if (Config.dig_royale && player.body && (player.body.royaleFrozen || (global.royaleInFall && global.royaleInFall(player.body)))) break;   // falling, or the raid-end freeze

                m[0] = util.isStringified(m[0]);
                if (Array.isArray(m[0])) m[0] = m[0][0];
                if (m.length !== 2) {
                    socket.kick("Ill-sized upgrade request.");
                    return 1;
                }

                let upgrade = m[0];
                let branchId = m[1];

                if (typeof upgrade != "number" || upgrade < 0 || typeof branchId != "number" || branchId < 0) {
                    if (!upgrade.isDailyUpgrade) {
                        socket.kick("Bad upgrade request.");
                        return 1;
                    }
                }

                if (player.body != null) {
                    if (Config.tutorial) {
                        const tut = require('../tutorialSession.js');
                        // Only the step that teaches evolving may evolve.
                        if (!tut.allows(player.body, 'upgrade')) return;
                        // A borrowed tank is on loan: never evolve it.
                        if (tut.borrowing(player.body)) return;
                        // Under a path lock the client's indexes point into the FILTERED menu while
                        // upgrade() indexes the raw list, so they could land on a hidden tank. There
                        // is exactly one legal choice under a lock: take it from the raw list.
                        if (player.body._tutorialLock) {
                            const b = player.body;
                            const idx = b.upgrades.findIndex(u =>
                                b.skill.level >= u.level && tut.upgradeAllowed(b, u));
                            if (idx >= 0) { b.upgrade(idx, 0); tut.noteUpgraded(b); }
                            return;
                        }
                        const before = player.body.index;
                        player.body.upgrade(upgrade, branchId);
                        if (player.body.index !== before) tut.noteUpgraded(player.body);
                        return;
                    }
                    player.body.upgrade(upgrade, branchId);
                }
            } break;
            case "x": {
                if (Config.dig_royale && player.body && (player.body.royaleFrozen || (global.royaleInFall && global.royaleInFall(player.body)))) break;

                if (m.length !== 2) {
                    socket.kick("Ill-sized skill request.");
                    return 1;
                }
                let number = m[0],
                    max = m[1],
                    stat = ["atk", "hlt", "spd", "str", "pen", "dam", "rld", "mob", "rgn", "shi", "min"][number];

                if (typeof number != "number") {
                    socket.kick("Weird stat upgrade request number.");
                    return 1;
                }
                if (typeof max != "number") {
                    socket.kick("Weird stat upgrade request max boolean.");
                    return 1;
                }
                if (max !== 0 && 1 !== max) {
                    socket.kick("invalid upgrade request max boolean.");
                    return 1;
                }

                if (!stat) {
                    socket.kick("Unknown stat upgrade request.");
                    return 1;
                }

                // Tutorial: stat points are only spendable during the stat lessons, one bar
                // each. Gated here, not in the UI, because 1-0 and M bypass the bars.
                if (Config.tutorial && player.body) {
                    const tut = require('../tutorialSession.js');
                    if (!tut.allowsStat(player.body, number)) return;
                    // Point by point, so a max-out (F + key) still stops at
                    // the step's budget instead of dumping the lot.
                    const b = player.body;
                    let limit = 256;
                    do {
                        const before = b.skill.points;
                        b.skillUp(stat);
                        if (b.skill.points < before) tut.noteStatSpent(b);
                        else break;
                    } while (limit-- && max && b.skill.points && b.skill.amount(stat) < b.skill.cap(stat) && tut.allowsStat(b, number));
                    return;
                }

                if (player.body != null) {
                    let limit = 256;
                    do {
                        player.body.skillUp(stat);
                    } while (limit-- && max && player.body.skill.points && player.body.skill.amount(stat) < player.body.skill.cap(stat))
                }

            } break;
            case "L": {

                if (m.length !== 0) {
                    socket.kick("Ill-sized level-up request.");
                    return 1;
                }

                if (player.body == null || player.body.underControl) return;

                if (!Config.manual_level_up && !(socket.permissions && socket.permissions.infiniteLevelUp)) return;
                if (player.body.skill.level < Config.level_cap_cheat || (socket.permissions && socket.permissions.infiniteLevelUp)) {
                    player.body.skill.score += player.body.skill.levelScore;
                    player.body.skill.maintain();
                    player.body.refreshBodyAttributes();
                }
            } break;
            case "0": {

                if (m.length !== 0) {
                    socket.kick("Ill-sized testbed request.");
                    return 1;
                }

                if (
                    player.body != null &&
                    socket.permissions &&
                    socket.permissions.class
                ) {
                    player.body.define({RESET_UPGRADES: true, BATCH_UPGRADES: false});
                    player.body.define(socket.permissions.class);
                    let msg = Config.token_message.split("\n");
                    if (!socket.status.specialTankWarned) {
                        socket.status.specialTankWarned = true;
                        for (let i = 0; i < msg.length; i++) {
                            player.body.sendMessage(msg[i]);
                        }
                    }
                }
            } break;
            case "TUT": {
                // Tutorial lesson commands. Only ever honoured on the tutorial
                // server: on a live server this whole case is inert, so a
                // crafted packet can't spawn bots or heal anyone.
                if (!Config.tutorial) return;
                if (player.body == null) return;
                if (!m.length || typeof m[0] !== "string") return;

                const tut = require('../tutorialSession.js');
                const plot = tut.plotOf(socket);
                if (plot < 0) return;
                const body = player.body;

                switch (m[0]) {
                    // The client's plot landmarks: it knows the room, not how it was split into plots.
                    case "hello": tut.talkPlotInfo(socket); break;

                    // Spawn the stationary practice target.
                    case "dummy": tut.spawnDummy(plot); break;

                    // Spawn the first opponent that shoots back (botSkill 0.1).
                    case "fighter": tut.spawnFighter(plot); break;

                    // Restrict the upgrade menu to one tank so a lesson can teach a specific
                    // build (penta shot, then a drone tank).
                    case "lock":
                        if (typeof m[1] !== "string") return;
                        tut.lockUpgrades(body, m[1]);
                        break;
                    case "unlock": tut.unlockUpgrades(body); break;

                    // Turn the learner's tank into a specific class (drone
                    // lesson). Allowlisted inside morph().
                    case "morph":
                        if (typeof m[1] !== "string") return;
                        tut.morph(body, m[1]);
                        break;
                    // Borrow a tank for a quick try, then hand the learner's
                    // own pick back ("untry").
                    case "try":
                        if (typeof m[1] !== "string") return;
                        tut.tryTank(body, m[1]);
                        break;
                    case "untry": tut.untry(body); break;
                    // Back to the spawn tank (tank chapter replay).
                    case "basetank": tut.baseTank(body); break;
                    // Drill, gear, kit and sidearm back to nothing (shop chapter replay).
                    case "shopreset": tut.resetShop(socket); break;
                    // Base lesson fallback: the practice base is yours.
                    case "givebase": tut.giveBase(plot, body); break;

                    // Chip health and shield so both bars visibly regenerate. Never lethal:
                    // clamps to a fraction of max rather than dealing damage.
                    case "hurt":
                        if (body.health && body.health.max) {
                            body.health.amount = Math.min(
                                body.health.amount, body.health.max * 0.12);
                        }
                        if (body.shield && body.shield.max) body.shield.amount = 0;
                        break;

                    // Set stats outright, in skill-bar order. Chapters about flying a tank hand
                    // out a working build instead of making the learner guess one.
                    case "stats": {
                        if (typeof m[1] !== "string") return;
                        const list = m[1].split(",").map(x => parseInt(x, 10) || 0);
                        tut.setStats(body, list);
                    } break;

                    // Grant points to spend, e.g. when a morph unlocks a stat the learner has never seen.
                    case "points":
                        tut.grantPoints(body, parseInt(m[1], 10) || 0);
                        break;

                    // Spend every point still in hand on an all-round build
                    // (after the stat lesson has had the learner place a few).
                    case "spendrest": tut.spendRest(body); break;

                    // Max every stat this tank can use except one, and leave
                    // exactly that many points in hand for it: "fill,6,1".
                    case "fill":
                        tut.fillStats(body, parseInt(m[1], 10),
                                      m[2] === undefined ? 1 : parseInt(m[2], 10) || 0);
                        break;

                    // Full health and shield, after the lesson that chipped them.
                    case "heal": tut.heal(body); break;

                    // Put the learner on the landmark the lesson is about.
                    case "goto":
                        if (typeof m[1] !== "string") return;
                        tut.teleport(socket, m[1]);
                        break;

                    // Land next to a specific world point (the marked rock).
                    case "gotoxy":
                        tut.teleportTo(socket, parseFloat(m[1]), parseFloat(m[2]));
                        break;

                    // Force a command toggle (the drone chapter switches
                    // auto-fire off so drones visibly recall on release).
                    case "cmd":
                        if (typeof m[1] !== "string") return;
                        // "0"/"1", not truthiness: the string "0" is truthy.
                        tut.setCommand(socket, m[1], String(m[2]) === "1");
                        break;

                    // Set the satchel outright. The core-chamber lesson zeroes
                    // it first so the 4000 that spills out of the ring is the
                    // only number the learner ever sees.
                    case "gems": {
                        const n = Math.max(0, parseInt(m[1], 10) || 0);
                        const gems = require('../terrain/gems.js');
                        body.carriedGems = Math.min(n, body.gemCap | 0 || n);
                        gems.updateSatchel(body);
                        gems.talkGems(body, 0);
                    } break;

                    // Declare what the current step permits. Anything not
                    // listed is refused at the socket until the next step.
                    case "allow":
                        tut.setAllowed(body, typeof m[1] === "string" ? m[1] : "");
                        break;

                    // Clear the plot's scripted bots (leaving a lesson, replay).
                    case "clear": tut.clearBots(plot); break;

                    // ── Dig Royale chapter ──
                    // Banked gems for the shop lesson.
                    case "banked": tut.setBanked(body, parseInt(m[1], 10) || 0); break;
                    // Put a kit item in the learner's slots / mount a sidearm.
                    case "kit": tut.grantKit(socket, typeof m[1] === "string" ? m[1] : "medkit"); break;
                    case "arm": tut.grantArm(socket, typeof m[1] === "string" ? m[1] : "flak"); break;
                    case "gear": tut.grantGear(socket, typeof m[1] === "string" ? m[1] : "boots"); break;
                    // the ability lesson's fallback: hand the learner the one it sells
                    case "ability": {
                        const abil = require('../terrain/abilities.js');
                        if (abil.grant(socket, typeof m[1] === "string" ? m[1] : "grapple")) abil.talkState(socket);
                    } break;
                    // A loot chest beside the learner.
                    case "chest": tut.spawnChest(plot); break;
                    // A weakened training copy of a raid boss.
                    case "boss": tut.spawnBoss(plot, typeof m[1] === "string" ? m[1] : "warden"); break;
                    case "bossclear": tut.clearBoss(plot); break;
                    // Fresh start: this plot's base back to neutral and locked.
                    case "reset": tut.resetBase(plot); break;
                    // The base lesson has begun: the base can be shot now.
                    case "openbase": tut.openBase(plot); break;
                }
            } break;
            case "EP": {
                // raids have no enemy pings: solos is every tank for itself,
                // and duos pings the partner through "PG"
                if (Config.dig_royale) return;
                if (m.length !== 2 || typeof m[0] !== "number" || typeof m[1] !== "number" ||
                    !isFinite(m[0]) || !isFinite(m[1])) {
                    return; 
                }
                if (player.body == null) return;
                const nowP = Date.now();
                if (socket.status.lastEnemyPing && nowP - socket.status.lastEnemyPing < 500) return;
                socket.status.lastEnemyPing = nowP;
                const room = global.gameManager.room;
                const pxw = Math.max(-room.width / 2, Math.min(room.width / 2, m[0]));
                const pyw = Math.max(-room.height / 2, Math.min(room.height / 2, m[1]));
                const pteam = player.body.team;
                global.gameManager.gameHandler?.addEnemyMarker(pteam, pxw, pyw, player.body.id);
                for (const s of global.gameManager.socketManager.clients) {
                    const b = s.player && s.player.body;
                    if (!b || b.team !== pteam) continue;
                    s.talk("EP", Math.round(pxw), Math.round(pyw), player.body.id);
                }
            } break;
            case "1": {

                if (player.body != null && !player.body.underControl && player.body.invuln) {
                    for (const instance of entities.values()) {
                        if (
                            instance.settings.clearOnMasterUpgrade &&
                            instance.master.id === player.body.id
                        ) {
                            instance.kill();
                        }
                    }
                    player.body.sendMessage("You have self-destructed.");
                    player.body.destroy();
                }
            } break;
            case "H": {
                if (player.body == null) return 1;
                let ent = [];
                let body = player.body;
                for (let e of entities.values()) {
                    if (e.isDominator || e.isMothership) ent.push(e);
                }
                body.emit("control", { body });
                if (body.underControl) {
                    let relinquishedControlMessage =
                    Config.domination ? "dominator" :
                    Config.mothership ? "mothership" :
                    "special tank"
                    if (Config.domination || Config.mothership) {
                        player.body.sendMessage(`You have relinquished control of the ${relinquishedControlMessage}.`);
                        body.giveUp(player, body.isDominator ? "" : undefined);
                        return 1;
                    }
                }
                if (Config.mothership) {
                    let motherships = ent
                        .map((entry) => {
                            if (
                                entry.isMothership &&
                                entry.team === player.body.team &&
                                !entry.underControl
                            )
                                return entry;
                        })
                        .filter((instance) => instance);
                    if (!motherships.length) {
                        player.body.sendMessage("There are no motherships available that are on your team or already controlled by an player.");
                        return 1;
                    }
                    let mothership = motherships.shift();
                    mothership.controllers = [];
                    mothership.underControl = true;
                    player.body = mothership;
                    player.body.become(player);
                    body.kill();
                    if (!player.body.dontIncreaseFov) player.body.FOV += 0.5;
                    player.body.dontIncreaseFov = true;
                    player.body.skill.points = 0;
                    player.body.refreshBodyAttributes();
                    player.body.name = body.name;
                    player.body.sendMessage("You are now controlling the mothership.");
                    player.body.sendMessage("Press F to relinquish control of the mothership.");
                } else if (Config.domination) {
                    let dominators = ent.map((entry) => {
                        if (entry.isDominator && entry.team === player.body.team && !entry.underControl) return entry;
                    }).filter(x=>x);
                    if (!dominators.length) {
                        player.body.sendMessage("There are no dominators available that are on your team or already controlled by an player.");
                        return 1;
                    }
                    let dominator = dominators.shift();
                    dominator.controllers = [];
                    dominator.underControl = true;
                    player.body = dominator;
                    player.body.become(player, true);
                    body.dontSendDeathMessage = true;
                    body.kill();
                    if (!player.body.dontIncreaseFov) player.body.FOV += 0.5;
                    player.body.dontIncreaseFov = true;
                    player.body.skill.points = 0;
                    player.body.refreshBodyAttributes();
                    player.body.name = body.name;
                    player.body.sendMessage("You are now controlling the dominator.");
                    player.body.sendMessage("Press F to relinquish control of the dominator.");
                } else {
                    player.body.sendMessage("There are no special tanks in this mode that you can control.");
                }
            } break;
            case "M": {
                // "$broadcast <text>" from an admin account: a popup on every
                // raid server. Anyone else's "$broadcast" is ordinary chat.
                if (typeof m[0] === "string" && /^\$broadcast(\s|$)/i.test(m[0]) &&
                    accountBridge.adminBroadcast && accountBridge.adminBroadcast(socket, m[0])) break;
                // "$restore CODE": a save code (terrain/saveCodes.js). Never
                // shown as chat and never logged, it's as good as the tank.
                if (typeof m[0] === "string" && /^\s*\$restore(\s|$)/i.test(m[0])) {
                    if (m[0].length > 120) return 1;
                    activity.noteChat(socket);
                    try { require('../terrain/saveCodes.js').chat(socket, m[0]); } catch (e) { console.error('[saves] restore', e && e.message); }
                    break;
                }
                if (player.body == null) return 1;
                activity.noteChat(socket);
                let abort, message = m[0], original = m[0];

                if ("string" !==  typeof message) {
                    socket.kick("Non-string chat message.");
                    return 1;
                }

                util.log(player.body.name + ': ' + original);

                if (Config.sanitize_chat_input) {

                    message = message.replace(/§/g, "§§§§");
                    original = original.replace(/§/g, "§§§§");
                }

                Events.emit('chatMessage', { gameManager: global.gameManager, message: original, socket, preventDefault: () => abort = true, setMessage: str => message = str });

                if (abort) break;

                if (message !== original) {
                    util.log('changed to: ' + message);
                }

                let id = player.body.id;
                if (!chats[id]) {
                    chats[id] = {};
                    chats[id].messages = [];
                }

                const chatTeam = m[1] ? player.body.team : null;
                chats[id].messages.unshift({ message, team: chatTeam, expires: Date.now() + Config.chat_message_duration, id: global.chatID++ });

                if (chats[id].messages.length > 3) chats[id].messages.length = 3;

                this.chatLoop();
            } break;
            case "T": {

                if (player.body && socket.status.lastTank != player.body.index) {
                    socket.status.lastTank = player.body.index;
                    this.sendMockup(player.body.index, socket);
                    let allRoots = [],
                        rerootUpgradeTree = [];
                    for (let i of player.body.index.split("-")) {
                        let mockup = mockupData.find(o => o.index === `${i}`);
                        if (mockup.rerootUpgradeTree) allRoots.push(...mockup.rerootUpgradeTree.split("\\/"));
                    }
                    for (let root of allRoots) {
                        if (!rerootUpgradeTree.includes(root)) rerootUpgradeTree.push(root);
                    }
                    for (let i of rerootUpgradeTree) {
                        let ind = Class[i].index;
                        this.sendMockupUpgrades(ind, socket);
                    }
                }
                socket.talk("T");
            } break;
            case "DTA": {
                if (!Config.daily_tank) return socket.kick("Bad daily tank ad request");
                if (player.body && player.body.skill.level >= Config.tier_multiplier * Config.daily_tank.tier && Config.daily_tank.ads && !socket.status.daily_tank_watched_ad) {
                    let chosenAd = ran.choose(Config.daily_tank.ad_sources);
                    let isImage = chosenAd.file.endsWith(".png") || chosenAd.file.endsWith(".jpg") || chosenAd.file.endsWith(".jpeg")
                    socket.talk("DTA", JSON.stringify({src: chosenAd.file, normalAdSize: chosenAd.use_regular_ad_size ?? true, waitTime: isImage ? chosenAd.image_wait_time : "isVideo"}));
                    if (isImage) {
                        setTimeout(() => {
                            setTimeout(() => {
                                socket.status.daily_tank_watched_ad_client = true;
                            }, `${chosenAd.WAIT_TIME}000`)
                        }, socket.camera.ping)
                    }
                }
            } break;
            case "DTAD": {
                if (!Config.daily_tank) return socket.kick("Bad daily tank ad request");
                if (socket.status.daily_tank_watched_ad_client) {
                    socket.status.daily_tank_watched_ad = true;
                    socket.talk("DTAD");
                }
            } break;
            case "DTAST": {
                if (!Config.daily_tank) return socket.kick("Bad daily tank ad request");
                let time = String(m[0]).split(".")[0];
                socket.talk("DTAST");
                setTimeout(() => {
                    setTimeout(() => {
                        socket.status.daily_tank_watched_ad_client = true;
                    }, `${time}000`)
                }, socket.camera.ping);
            } break;
            case "NWB": {
                socket.status.forceNewBroadcast = true;
            } break;
            case "RS": {
                if (!socket.status.deceased) return 1;
                activity.noteAction(socket);
                socket.royaleWantsSpectate = true;
                const code = m[0] | 0;
                // 3: your duo partner (falls back to the killer / nearest)
                const mateBody = code === 3 && Config.royale_duos ? require('../duo/duoRaid.js').mateOfSocketBody(socket) : null;
                if (mateBody) {
                    socket.spectateEntity = mateBody;
                } else if (code === 2 || code === 3) {
                    const killer = socket.spectateKiller;
                    if (killer && !killer.isDead?.() && (killer.isPlayer || killer.isBot)) {
                        socket.spectateEntity = killer;
                    } else {
                        nearestSpectate(socket, socket.lastDeathX || socket.camera.x, socket.lastDeathY || socket.camera.y);
                    }
                } else {
                    cycleSpectate(socket, code === 0 ? -1 : 1);
                }
                if (socket.spectateEntity && socket.camera) {
                    socket.camera.x = socket.spectateEntity.x;
                    socket.camera.y = socket.spectateEntity.y;
                    socket.talk("u", true, socket.camera.x, socket.camera.y);
                }
            } break;
            case "GI": {
                // guest id: this browser's lasting random id (admin guest stats)
                if (socket.guestId || typeof m[0] !== "string" || !/^[a-f0-9]{32}$/.test(m[0])) return;
                socket.guestId = m[0];
                // where this browser first came from (a site name, see accounts/guests.js)
                if (typeof m[1] === "string" && m[1].length <= 56) socket.guestSource = m[1];
                try { accountBridge.onGuestId(socket); } catch (e) { /* tracking only */ }
            } break;
            case "VZ": {
                // the tab went hidden or frozen (1, 2) or came back (0)
                if (m.length !== 1 || (m[0] !== 0 && m[0] !== 1 && m[0] !== 2)) return;
                linkWatch.noteVisibility(socket, m[0], Date.now());
            } break;
            case "LV": {
                // leaving on purpose (menu, Home, exit): no resume for this one
                socket.leftOnPurpose = true;
            } break;
            case "RZ": {
                // resume token: a per-tab id the client re-sends after a drop
                if (typeof m[0] !== "string" || !/^[a-z0-9]{8,64}$/i.test(m[0])) return;
                if (socket.resumeToken) return;
                socket.resumeToken = m[0];
                if (process.env.RESUME_DEBUG) console.log('[RESUME] token set on', String(socket.id).slice(0, 6));
                if (Config.dig_royale) {
                    // Same tab is back while its old socket still looks open (half-open drop;
                    // the heartbeat takes minutes to notice). Retire the old one now, like the
                    // accounts' newest-session rule, so its raid is saved for this claim.
                    const myAcct = (socket.account && socket.account.id) || null;
                    for (const o of this.clients.slice()) {
                        if (o === socket || o.resumeToken !== m[0]) continue;
                        if (((o.account && o.account.id) || null) !== myAcct) continue;
                        try { accountBridge.kickOut(o, 'You opened the game in another tab.'); } catch (e) { console.error('[RESUME] supersede', e && e.message); }
                    }
                    const ok = require('../gamemodes/scripts/dig_royale.js').claimResume(socket, m[0]);
                    if (ok) util.log("[INFO]: A dropped player reconnected and resumed their raid.");
                }
            } break;
            case "DQ": {
                // duo hello: [party ticket or "", fill 0/1], sent before spawning
                if (!Config.royale_duos) return;
                if (m.length !== 2 || typeof m[0] !== "string" || m[0].length > 2048) return;
                require('../duo/duoRaid.js').onHello(socket, m[0], m[1] === 0 ? 0 : 1);
            } break;
            case "DX": {
                // duo waiting screen: "cancel" (leaving for the menu) or "solo"
                if (!Config.royale_duos) return;
                if (m.length !== 1 || (m[0] !== "cancel" && m[0] !== "solo")) return;
                require('../duo/duoRaid.js').onWaitAction(socket, m[0]);
            } break;
            case "TC": {
                // duos: team chat, to your partner only (alive or dead, any distance)
                if (!Config.royale_duos) return;
                if (m.length !== 1 || typeof m[0] !== "string" || m[0].length > 200) return;
                activity.noteChat(socket);
                require('../duo/duoComms.js').teamChat(socket, m[0]);
            } break;
            case "PG": {
                // duos: quick ping at a world spot, to your partner only
                if (!Config.royale_duos) return;
                if (m.length !== 2 || typeof m[0] !== "number" || typeof m[1] !== "number") return;
                require('../duo/duoComms.js').ping(socket, m[0], m[1]);
            } break;
            case "RQ": {
                if (!Config.dig_royale) return 1;
                require('../gamemodes/scripts/dig_royale.js').requestPlay();
            } break;
            case "sb": {
                // shop buy: item id string
                if (!Config.dig_royale && !Config.tutorial) return 1;
                if (m.length !== 1 || typeof m[0] !== "string" || m[0].length > 24) { socket.kick("Bad shop request."); return 1; }
                if (Config.tutorial) {
                    // Each shop step sells one category ("shop:drill").
                    const it = require('../terrain/shop.js').BY_ID.get(m[0]);
                    if (!require('../tutorialSession.js').allows(player.body, 'shop', it ? it.cat : '?')) return;
                }
                const nowB = Date.now();
                if (nowB - (socket._lastBuyAt || 0) < 120) return;
                socket._lastBuyAt = nowB;
                require('../terrain/shop.js').buy(socket, m[0]);
            } break;
            case "SV": {
                // Save & leave: 1 starts the 20 s hold, 0 cancels it
                if (!Config.dig_royale || Config.tutorial) return 1;
                if (m.length !== 1 || (m[0] !== 0 && m[0] !== 1)) return;
                activity.noteAction(socket);
                require('../terrain/saveCodes.js').onPacket(socket, m[0] === 1);
            } break;
            case "CO": {
                // the first-raid coach is on screen (1) or not (0): no contracts meanwhile
                if (!Config.dig_royale) return 1;
                socket.coachOn = m[0] === 1;
            } break;
            case "kd": {
                // kit drop: slot (dragged out of the box)
                if (!Config.dig_royale && !Config.tutorial) return 1;
                if (typeof m[0] !== "number" || m[0] < 0 || m[0] > 2) return;
                // Tutorial: throwing an item away would pass for using it, so
                // drops only work where every kit item is fair game.
                if (Config.tutorial && !require('../tutorialSession.js').allowsAll(player.body, 'kit')) return;
                require('../terrain/shop.js').dropKit(socket, m[0] | 0);
            } break;
            case "sk": {
                // kit use: slot, world x, world y
                if (!Config.dig_royale && !Config.tutorial) return 1;
                if ((m.length !== 3 && m.length !== 4) || typeof m[0] !== "number" || typeof m[1] !== "number" || typeof m[2] !== "number") { socket.kick("Bad kit request."); return 1; }
                if (m[0] < 0 || m[0] > 2) return;
                if (player.body && (player.body.royaleFrozen || (global.royaleInFall && global.royaleInFall(player.body)))) return;
                if (Config.tutorial) {
                    // "kit:medkit": only the item the step is about fires.
                    const shopMod = require('../terrain/shop.js');
                    const st = shopMod.stateOf(socket);
                    const kid = (typeof m[3] === "string" && m[3]) || (st && st.kitOrder && st.kitOrder[m[0] | 0]) || '?';
                    if (!require('../tutorialSession.js').allows(player.body, 'kit', kid)) return;
                }
                if (socket._saving) require('../terrain/saveCodes.js').interrupt(socket, "You used a kit item, so the save stopped.");
                require('../terrain/shop.js').useKit(socket, m[0] | 0, m[1], m[2], typeof m[3] === "string" && m[3].length <= 24 ? m[3] : undefined);
            } break;
            case "ab": {
                // dash (0), ability at a world spot (1, x, y), Barricade preview (3, x, y)
                if (!Config.dig_royale && !Config.tutorial) return 1;
                if (m.length < 1 || m.length > 3 || typeof m[0] !== "number" || (m.length > 1 && (typeof m[1] !== "number" || typeof m[2] !== "number"))) { socket.kick("Bad ability request."); return 1; }
                const abil = require('../terrain/abilities.js');
                if (!abil.ON || !player.body) return;
                if (global.royaleInFall && global.royaleInFall(player.body)) return;   // still falling in
                activity.noteAction(socket);
                if (m[0] === 0) abil.dash(player.body, 0, 0);
                else if (m[0] === 1) abil.use(player.body, m[1], m[2]);
                else if (m[0] === 3) { if (abil.preview) abil.preview(socket, m[1], m[2]); return; }
            } break;
            case "DBG": {
                // local verification only: never active without ROYALE_DEBUG,
                // except the banked-gem grant, which a localhost client may use
                // to try items (window.dwGems(n) in the console)
                const what = String(m[0] || "");
                // socket.ip comes from clientIp(), so a forged X-Forwarded-For
                // can't pass for localhost. Production never takes DBG at all.
                const localSocket = /^(::1|127\.0\.0\.1|::ffff:127\.0\.0\.1)$/.test(String(socket.ip || ""));
                if (!Config.dig_royale || isProduction()) return 1;
                if (!process.env.ROYALE_DEBUG && !(localSocket && what === "gems")) return 1;
                const b = player && player.body;
                try {
                    if (what === "gems" && b) { const gm = require('../terrain/gems.js'); gm.setBanked(b, Math.max(0, Math.min(1e6, (m[1] | 0) || 5000))); gm.talkGems(b, 0); }
                    else if (what === "shop" && b) { const sh = require('../terrain/shop.js').getShops()[m[1] | 0]; if (sh) { b.x = sh.x; b.y = sh.y; b.velocity.x = 0; b.velocity.y = 0; } }
                    else if (what === "vault" && b) { const v = require('../terrain/vault.js').getVaults()[m[1] | 0]; if (v) { b.x = v.x; b.y = v.y; b.velocity.x = 0; b.velocity.y = 0; } }
                    else if (what === "boss") require('../terrain/bosses.js').spawn(m[1] ? String(m[1]) : undefined);
                    else if (what === "contract" && b) socket.talk('KC', 'chest', String(require('../terrain/contracts.js').debugForce(b, String(m[1] || 'mine'))), 0);
                    else if (what === "supply" || what === "bounty") require('../terrain/pacing.js').debugFire(what);
                    else if (what === "chests") socket.talk('KC', 'chest', JSON.stringify(require('../terrain/chests.js').debugInfo()), 0);
                    else if (what === "toepic" && b) {
                        // beside the nearest epic chest, on its open side
                        const list = require('../terrain/chests.js').alive().filter(c => c.chestRare && !c._opened);
                        list.sort((p, q) => ((p.x - b.x) ** 2 + (p.y - b.y) ** 2) - ((q.x - b.x) ** 2 + (q.y - b.y) ** 2));
                        const ch = list[0];
                        if (ch) {
                            const tg = global.gameManager.terrainGrid;
                            let spot = null;
                            for (const [dx, dy] of [[160, 0], [-160, 0], [0, 160], [0, -160], [120, 120], [-120, -120]]) {
                                if (!tg.pointInRock || !tg.pointInRock(ch.x + dx, ch.y + dy)) { spot = { x: ch.x + dx, y: ch.y + dy }; break; }
                            }
                            if (spot) { b.x = spot.x; b.y = spot.y; b.velocity.x = 0; b.velocity.y = 0; }
                        }
                    }
                    else if (what === "tobot" && b) {
                        // beside the nearest live bot, for kill/revenge testing
                        let best = null, bd = Infinity;
                        for (const e of entities.values()) {
                            if (!e || !e.isBot || e.isDead?.() || e === b) continue;
                            const d = (e.x - b.x) ** 2 + (e.y - b.y) ** 2;
                            if (d < bd) { bd = d; best = e; }
                        }
                        if (best) { b.x = best.x + 140; b.y = best.y; b.velocity.x = 0; b.velocity.y = 0; b.invuln = false; }
                    }
                    else if (what === "tohuman" && b) {
                        // beside the nearest other live human, for ranked damage tests
                        let best = null, bd = Infinity;
                        for (const e of entities.values()) {
                            if (!e || !e.socket || e.type !== "tank" || e.isDead?.() || e === b) continue;
                            const d = (e.x - b.x) ** 2 + (e.y - b.y) ** 2;
                            if (d < bd) { bd = d; best = e; }
                        }
                        const off = Math.max(60, Math.min(400, (m[1] | 0) || 140));
                        if (best) { b.x = best.x + off; b.y = best.y; b.velocity.x = 0; b.velocity.y = 0; }
                    }
                    // duos: this socket's team, colour and partner, the bot duo,
                    // and a friendly-fire probe (tests read it off KC 'dbg')
                    else if (what === "duo" && Config.royale_duos) {
                        const dr = require('../duo/duoRaid.js');
                        const tm = dr.book.teamOf(socket.duoKey);
                        const mb = b ? dr.mateBody(b) : null;
                        const bots = (global.gameManager.gameHandler.bots || []).filter(x => x && !x.isDead());
                        const out = {
                            key: socket.duoKey || null, pid: socket.duoPid || null, fill: socket.duoFill !== false,
                            team: b ? b.team : null, color: b ? b.color.base : null, bookTeam: tm ? tm.id : null,
                            members: tm ? [...tm.members.values()].map(x => ({ mk: x.mk, name: x.name, away: !!x.away })) : [],
                            mate: mb ? { id: mb.id, name: mb.name, team: mb.team, color: mb.color.base, x: Math.round(mb.x), y: Math.round(mb.y) } : null,
                            me: b ? { id: b.id, x: Math.round(b.x), y: Math.round(b.y), hp: b.health.amount, invuln: !!b.invuln, hitBy: b._duoHitBy ? b._duoHitBy.id : 0, hitAgo: b._duoHitAt ? Date.now() - b._duoHitAt : -1 } : null,
                            bots: bots.map(x => ({ id: x.id, name: x.name, team: x.team, color: x.color.base, duo: !!x.isDuoBot, tb: !!x.isTeamBot, key: x.duoTeamKey || null, mate: x.duoMate && !x.duoMate.isDead() ? x.duoMate.id : 0, x: Math.round(x.x), y: Math.round(x.y), hp: x.health.amount, goal: x._digWarsGoal || null, enemy: x._botEnemyId || 0, rg: x._regroupDbg || null })),
                            teams: [...dr.book.teams.values()].map(t => ({ id: t.id, pid: t.pid, fill: t.fill, n: t.members.size, color: t.color, key: t.key, bot: t.bot ? { name: t.bot.name, id: t.bot.body && !t.bot.body.isDead() ? t.bot.body.id : 0, respawnAt: t.bot.respawnAt } : null })),
                            waiting: [...dr.book.waiting.values()].map(w => ({ mk: w.mk, name: w.name, since: w.since })),
                            teamKey: b ? dr.teamKeyOf(b) : null,
                            bases: require('../terrain/outposts.js').getOutposts().map(o => ({ id: o.id, ownerId: o.ownerId, team: o.team, key: o.ownerKey, mine: b ? require('../terrain/outposts.js').isOwner(o, b) : false, x: Math.round(o.x), y: Math.round(o.y) })),
                            onOwnPad: b ? !!b.outpostOnPad : false,
                        };
                        socket.talk('KC', 'dbg', JSON.stringify({ duo: out }), 0);
                    }
                    // duos: the nearest enemy bot comes to 450 from you and counts as
                    // having just shot you (a bot teammate should turn on it)
                    else if (what === "duohit" && Config.royale_duos && b) {
                        let best = null, bd = Infinity;
                        for (const e of entities.values()) {
                            if (!e || !e.isBot || e.isDead?.() || e.team === b.team) continue;
                            const d = (e.x - b.x) ** 2 + (e.y - b.y) ** 2;
                            if (d < bd) { bd = d; best = e; }
                        }
                        if (best) {
                            if (m[1]) { best.x = b.x + (m[1] > 1 ? Math.min(900, m[1]) : 450); best.y = b.y; best.velocity.x = 0; best.velocity.y = 0; }
                            best.invuln = false;
                            if (m[2] !== 0) { b._duoHitBy = best; b._duoHitAt = Date.now(); }
                        }
                        socket.talk('KC', 'dbg', JSON.stringify({ duohit: best ? { id: best.id, hp: best.health.amount, x: Math.round(best.x), y: Math.round(best.y) } : null }), 0);
                    }
                    else if (what === "killteambot" && Config.royale_duos) {
                        const tb = require('../duo/duoRaid.js').teamBotBody(socket);
                        if (tb) { tb.invuln = false; tb.godmode = false; tb.health.amount = -1; }
                    }
                    else if (what === "claimbase" && Config.royale_duos && b) {
                        const op = require('../terrain/outposts.js');
                        const site = op.getOutposts()[m[1] | 0];
                        if (site) op.claimSite(site.id, b);
                    }
                    else if (what === "tobase" && b) {
                        const site = require('../terrain/outposts.js').getOutposts()[m[1] | 0];
                        if (site) { b.x = site.x; b.y = site.y; b.velocity.x = 0; b.velocity.y = 0; }
                    }
                    else if (what === "tomate" && Config.royale_duos && b) {
                        const mb = require('../duo/duoRaid.js').mateBody(b);
                        const off = Math.max(60, Math.min(600, (m[1] | 0) || 160));
                        if (mb) { b.x = mb.x + off; b.y = mb.y; b.velocity.x = 0; b.velocity.y = 0; }
                    }
                    // ranked rank-only counters of this socket's open life
                    // growth: DBG score <n> sets the raid score, DBG growth reports size and stats
                    else if (what === "score" && b) {
                        const dr = require('../gamemodes/scripts/dig_royale.js');
                        socket.talk('KC', 'dbg', JSON.stringify({ score: dr.debugSetScore(b, m[1] | 0) }), 0);
                    }
                    // DBG botscore <n>: a live bot's raid score (the raid-end finale seen as a loser)
                    else if (what === "botscore") {
                        const st = require('../terrain/storm.js').snapshot();
                        const d2 = x => (x.x - st.cx) ** 2 + (x.y - st.cy) ** 2;
                        const bot = (global.gameManager.gameHandler?.bots || []).filter(x => x && !x.isDead()).sort((p, q) => d2(p) - d2(q))[0];
                        if (bot) socket.talk('KC', 'dbg', JSON.stringify({ botscore: require('../gamemodes/scripts/dig_royale.js').debugSetScore(bot, m[1] | 0), name: bot.name }), 0);
                    }
                    // DBG streak <n> [bot]: a streak on you, or on the bot nearest you
                    else if (what === "streak" && b) {
                        let t = b;
                        if (m[2]) {
                            const d2 = x => (x.x - b.x) ** 2 + (x.y - b.y) ** 2;
                            t = (global.gameManager.gameHandler?.bots || []).filter(x => x && !x.isDead()).sort((p, q) => d2(p) - d2(q))[0];
                        }
                        if (t) socket.talk('KC', 'dbg', JSON.stringify({ streak: require('../gamemodes/scripts/dig_royale.js').debugSetStreak(t, m[1] | 0), name: t.name, id: t.id }), 0);
                    }
                    else if (what === "botdiff") socket.talk('KC', 'dbg', JSON.stringify({ botdiff: require('../gamemodes/scripts/dig_royale.js').debugBotDiff(socket, m[1]) }), 0);
                    else if (what === "core") socket.talk('KC', 'dbg', JSON.stringify({ core: require('../gamemodes/scripts/dig_royale.js').debugCore(m[1], b) }), 0);
                    else if (what === "rattler" && b) {
                        const rt = require('../terrain/rattler.js'), st = require('../terrain/storm.js').snapshot();
                        const why = rt.whyNot(b, Date.now());
                        socket.talk('KC', 'dbg', JSON.stringify({ rattler: why || 'ok', spot: why ? null : rt.spotFor(b, st), alive: rt.alive().length }), 0);
                    }
                    else if (what === "supplydrop") require('../terrain/supplyDrops.js').debugNow();
                    else if (what === "rush") socket.talk('KC', 'dbg', JSON.stringify({ rush: !!require('../terrain/raidOpening.js').rush(Date.now()) }), 0);
                    else if (what === "huntme" && b) require('../terrain/hunted.js').onBanked(b);   // lift the newbie window
                    else if (what === "tocore" && b) { const cs = require('../terrain/coreFinale.js').siteOf(); if (cs) { b.x = cs.x + 260; b.y = cs.y; b.velocity.x = 0; b.velocity.y = 0; } }
                    else if (what === "growth") socket.talk('KC', 'dbg', JSON.stringify({ growth: require('../gamemodes/scripts/dig_royale.js').debugGrowth(b) }), 0);
                    else if (what === "bank") socket.talk('KC', 'dbg', JSON.stringify({ bank: require('../gamemodes/scripts/dig_royale.js').debugBank(socket) }), 0);
                    else if (what === "addgrowth" && b) socket.talk('KC', 'dbg', JSON.stringify({ addgrowth: require('../gamemodes/scripts/dig_royale.js').addGrowth(b, m[1] | 0) }), 0);
                    else if (what === "rankpts") socket.talk('KC', 'dbg', JSON.stringify({ rankpts: require('../../accounts/game/rankHooks.js').debugPts(socket) }), 0);
                    else if (what === "bosskill") {
                        // bosskill 1: you land the final blow (and the damage), for reward tests
                        const bm = require('../terrain/bosses.js'), bs = bm.current();
                        if (bs && b && m[1]) { bm.debugHit(b, 1000); bs.finalKillers = [b]; }
                        if (bs) bs.health.amount = -1;
                    }
                    else if (what === "openchest" && b) {
                        // open the nearest chest as if you broke it
                        const cm = require('../terrain/chests.js');
                        let best = null, bd = Infinity;
                        for (const c of cm.alive()) { if (c._opened) continue; const d = (c.x - b.x) ** 2 + (c.y - b.y) ** 2; if (d < bd) { bd = d; best = c; } }
                        if (best) cm.openChest(best, b);
                    }
                    else if (what === "bloom") { const bl = require('../terrain/blooms.js').start(); if (bl) require('../gamemodes/scripts/dig_royale.js').onBloom(bl); }
                    else if (what === "meteor") { const ev = require('../terrain/raidEvents.js').startMeteor(Date.now()); if (ev) require('../gamemodes/scripts/dig_royale.js').onEvent(ev); }
                    else if (what === "rain") { const ev = require('../terrain/raidEvents.js').startRain(Date.now()); if (ev) require('../gamemodes/scripts/dig_royale.js').onEvent(ev); }
                    else if (what === "chest" && b) require('../terrain/chests.js').spawnChest(b.x + 120, b.y, !!m[1]);
                    else if (what === "kill" && b) { b.health.amount = -1; }
                    // die to the nearest bot, as if it shot you (revenge / death screen checks)
                    else if (what === "killby" && b) {
                        const bots = (global.gameManager.gameHandler.bots || []).filter(o => o && !o.isDead());
                        bots.sort((p, q) => ((p.x - b.x) ** 2 + (p.y - b.y) ** 2) - ((q.x - b.x) ** 2 + (q.y - b.y) ** 2));
                        if (bots[0]) { b.godmode = false; b.invuln = false; b.finalKillers = [bots[0]]; b.collisionArray.push(bots[0]); b.health.amount = -1; }
                    }
                    else if (what === "god" && b) { b.godmode = !b.godmode; }
                    // a hit without a shooter (save-code tests: a save stops when you're hurt)
                    else if (what === "hurt" && b) { b.hitAt = Date.now(); b.health.amount = Math.max(1, b.health.amount - Math.max(1, (m[1] | 0) || 20)); }
                    else if (what === "me") socket.talk('KC', 'dbg', JSON.stringify(b ? { invuln: !!b.invuln, grace: Math.max(0, (b.spawnGraceUntil || 0) - Date.now()), x: Math.round(b.x), y: Math.round(b.y), hp: Math.round(b.health.amount), sh: Math.round(b.shield.amount), dead: !!(b.isDead && b.isDead()), carried: b.carriedGems | 0, arm: b.sidearmId || null } : { nobody: true }), 0);
                    // every human tank in the world (drop tests: a dropped player's tank is gone)
                    else if (what === "humans") socket.talk('KC', 'dbg', JSON.stringify({ humans: [...entities.values()].filter(e => e && e.socket && e.isPlayer && !(e.isDead && e.isDead())).map(e => e.name) }), 0);
                    else if (what === "chesthp" && b) {
                        const list = require('../terrain/chests.js').alive();
                        let best = null, bd = 1e12;
                        for (const c of list) { const d = (c.x - b.x) ** 2 + (c.y - b.y) ** 2; if (d < bd) { bd = d; best = c; } }
                        const info = best ? { hp: +(best.health.amount).toFixed(1), max: best.health.max, dmgN: best._dmgN | 0, gated: best._gatedN | 0, lastDmgAgo: best._lastDmgAt ? Date.now() - best._lastDmgAt : null, hitters: best.hitters ? best.hitters.size : 0, invuln: !!best.invuln, opened: !!best._opened, dist: Math.round(Math.sqrt(bd)), realSize: Math.round(best.realSize), myInvuln: !!b.invuln, myGod: !!b.godmode, myGrace: Math.max(0, (b.spawnGraceUntil || 0) - Date.now()) } : null;
                        socket.talk('KC', 'chest', JSON.stringify(info), 0);
                    }
                    else if (what === "carry" && b) { b.carriedGems = (b.carriedGems | 0) + (m[1] | 0 || 500); require('../terrain/gems.js').updateSatchel(b); require('../terrain/gems.js').talkGems(b, 0); }
                    // real gem entities of one ore (1 copper .. 4 emerald) dropped on you: the pickup path
                    else if (what === "gem" && b) {
                        const ore = Math.max(1, Math.min(4, m[1] | 0 || 1)), n = Math.max(1, Math.min(40, m[2] | 0 || 1));
                        const cls = { 1: 'gemPickupCopper', 2: 'gemPickupVein', 3: 'gemPickupShard', 4: 'gemPickupEmerald' }[ore];
                        const value = { 1: 15, 2: 30, 3: 150, 4: 500 }[ore];
                        for (let i = 0; i < n; i++) require('../terrain/gems.js').spawnGem(b.x, b.y, value, cls, 16, 0, 0, ore);
                    }
                    // the longest-lived bot off the pads dies to you (kill credit through the normal
                    // collision path), if it is at least m[1] ms old; answers KC 'dbg' {killbot, ageMs}
                    else if (what === "killbot" && b) {
                        let best = null;
                        for (const e of entities.values()) {
                            if (!e || !e.isBot || e.isDead?.() || e.isGhost || e.padSafe || e.onVaultPad || e.outpostOnPad) continue;
                            // 'near': the bot closest to you (death effect checks), else the oldest
                            if (m[2] === "near" ? (!best || (e.x - b.x) ** 2 + (e.y - b.y) ** 2 < (best.x - b.x) ** 2 + (best.y - b.y) ** 2)
                                : (!best || (e.royaleBornAt || 0) < (best.royaleBornAt || 0))) best = e;
                        }
                        const ageMs = best ? Date.now() - (best.royaleBornAt || 0) : -1;
                        const hit = !!best && ageMs >= Math.max(0, m[1] | 0);
                        if (hit) {
                            best.invuln = false; best.godmode = false; best.passive = false;
                            best.collisionArray.push(b);
                            best.damageReceived = (best.damageReceived || 0) + 1e-6;
                            best.health.amount = -1;
                        }
                        socket.talk('KC', 'dbg', JSON.stringify({ killbot: hit ? 1 : 0, ageMs }), 0);
                    }
                    // accounts test hooks: ROYALE_DEBUG + ACCOUNTS_ALLOW_DEBUG=1 only (bridge.debugOn)
                    else if (what === "rank" && accountBridge.debugOn()) require('../../accounts/game/rankHooks.js').debugRank(socket, m[1] | 0);
                    else if (what === "dust" && b && accountBridge.debugOn()) require('../../accounts/game/dustHooks.js').debugSetCarried(b, m[1] | 0);
                    else if (what === "tobos" && b) { const bs = require('../terrain/bosses.js').current(); if (bs) { b.x = bs.x + 300; b.y = bs.y; } }
                    else if (what === "tobloom" && b) { const bl = require('../terrain/blooms.js').current(); if (bl) { b.x = bl.x + 200; b.y = bl.y + 200; } }
                    else if (what === "toevent" && b) { const ev = require('../terrain/raidEvents.js').current(); if (ev) { b.x = ev.x + 250; b.y = ev.y; } }
                    else if (what === "tochest" && b) { const ch = require('../terrain/chests.js').alive()[0]; if (ch) { b.x = ch.x + 160; b.y = ch.y; } }
                    else if (what === "twist") require('../gamemodes/scripts/dig_royale.js').debugTwist(m[1] ? String(m[1]) : undefined);
                    else if (what === "raidend") require('../gamemodes/scripts/dig_royale.js').debugEndRaid();
                    // jump the storm to N seconds into its cycle (300 = a minute before the hold)
                    // the rock round you as the server sees it: [key, alive, rising, ore, carved, gap to its outline]
                    else if (what === "rocksnear" && b) {
                        const tg = global.gameManager.terrainGrid, R = +m[1] || 200, out = [];
                        for (const r of tg.rocks.values()) {
                            if (!r || !r.worldPoly || Math.hypot(r.worldCx - b.x, r.worldCy - b.y) > R + 120) continue;
                            const f = tg.constructor._polyFace(r.worldPoly, b.x, b.y), gap = f.inside ? 0 : f.dist;
                            if (gap <= R) out.push([r.k, r.alive ? 1 : 0, r.growing ? 1 : 0, r.ore | 0, r.canyon ? 1 : 0, Math.round(gap)]);
                        }
                        socket.talk('KC', 'dbg', JSON.stringify({ at: [Math.round(b.x), Math.round(b.y)], rocks: out }), 0);
                    }
                    else if (what === "stormat") require('../terrain/storm.js').debugSeek(m[1] | 0);
                    // put the storm's edge N units from you (negative: you're inside), you on its east side
                    else if (what === "stormedge" && b) { const st = require('../terrain/storm.js'); st.debugCenter(b.x - (st.radius() + (+m[1] || 0)), b.y); }
                    // break the rock between 180 and N (default 420) units of you and start it regrowing
                    // at once, so the near-tank slowdown can be watched. Answers KC 'dbg' with the count
                    else if (what === "regrowhere" && b) {
                        const tg = global.gameManager.terrainGrid, t = Date.now(), R = Math.max(200, +m[1] || 420);
                        let n = 0;
                        if (tg && tg.rocks) for (const rock of tg.rocks.values()) {
                            if (!rock.worldPoly || rock.canyon || rock.growing || rock.ore === 4) continue;
                            const d = Math.hypot((rock.worldCx || rock.wx) - b.x, (rock.worldCy || rock.wy) - b.y);
                            if (d < 180 || d > R) continue;
                            if (rock.alive) tg.damageRock(rock, rock.health + 1);
                            rock.noRegrowUntil = 0;
                            if (tg.startRegrow(rock, t) !== false) n++;
                        }
                        socket.talk('KC', 'dbg', JSON.stringify({ regrowhere: n }), 0);
                    }
                    // end the raid N seconds from now (late-join note, raid-over wait)
                    else if (what === "raidleft") require('../gamemodes/scripts/dig_royale.js').debugRaidLeft(m[1] | 0);
                    // N extra safe-spawn picks, each checked for a way out; 'trap' plants enclosed pockets first,
                    // 'reset' clears the tally. Answers KC 'dbg' with the audit
                    else if (what === "spawnaudit") socket.talk('KC', 'dbg', JSON.stringify({ spawnaudit: require('../gamemodes/scripts/dig_royale.js').debugSpawnAudit(m[1] | 0, m[2] ? String(m[2]) : '') }), 0);
                    // beside base N (or the nearest), on its open side
                    else if ((what === "tobase" || what === "takebase") && b) {
                        const ops = require('../terrain/outposts.js').getOutposts();
                        let site = m[1] !== undefined && m[1] !== "" ? ops[m[1] | 0] : null;
                        if (!site) { let bd = 1e12; for (const o of ops) { const d = (o.x - b.x) ** 2 + (o.y - b.y) ** 2; if (d < bd) { bd = d; site = o; } } }
                        if (site) {
                            if (what === "takebase" && site.banner && !site.banner.isDead?.()) { site._lastHitter = b; site.banner.godmode = false; site.banner.health.amount = -1; }
                            const tg = global.gameManager.terrainGrid;
                            for (const [dx, dy] of [[-260, 0], [260, 0], [0, 260], [0, -260], [190, 190], [-190, -190]]) {
                                if (!tg.pointInRock || !tg.pointInRock(site.x + dx, site.y + dy)) { b.x = site.x + dx; b.y = site.y + dy; break; }
                            }
                            b.velocity.x = 0; b.velocity.y = 0;
                        }
                    }
                } catch (e) { console.error("[DBG]", e && e.stack); }
            } break;
            default: {
                console.log(m)
                console.log("Invalid registered packet." + m);
            } break;
        }
    };

    spectateEntity(possible, socket) {
        let entries = [];
        for (const entry of entities.values()) {
            if (possible.includes("arenaCloser") && entry.isArenaCloser) entries.push(entry);
            if (possible.includes("players") && entry.isPlayer) entries.push(entry);
            if (possible.includes("bots") && entry.isBot) entries.push(entry);
        }
        if (!entries.length) {
            return 1;
        }
        let entity;
        do {
            entity = ran.choose(entries);
        } while (entity === socket.spectateEntity && entries.length > 1);
        socket.spectateEntity = entity;
    }

    traffic(socket) {
        let strikes = 0;

        return () => {

            if (util.time() - socket.status.lastHeartbeat > Config.max_heartbeat_interval) {
                socket.kick("Heartbeat lost.");
                return 0;
            }

            if (socket.status.requests > 50) {
                strikes++;
            } else {
                strikes = 0;
            }

            if (strikes > 3) {
                socket.kick("Socket traffic volume violation!");
                return 0;
            }

            socket.status.requests = 0;
        };
    }

    floppy(value = null) {
        let flagged = true;
        return {

            update: (newValue) => {
                let eh = false;
                if (value == null) {
                    eh = true;
                } else {
                    if (typeof newValue != typeof value) {
                        eh = true;
                    }

                    switch (typeof newValue) {
                        case "number":
                        case "string":
                            if (newValue !== value) {
                                eh = true;
                            }
                            break;
                        case "object":
                            if (Array.isArray(newValue)) {
                                if (newValue.length !== value.length) {
                                    eh = true;
                                } else {
                                    for (let i = 0, len = newValue.length; i < len; i++) {
                                        if (newValue[i] !== value[i]) eh = true;
                                    }
                                }
                                break;
                            }
                        default:
                            util.error(newValue);
                            throw new Error("Unsupported type for a floppyvar!");
                    }
                }

                if (eh) {
                    flagged = true;
                    value = newValue;
                }
            },

            publish: () => {
                if (flagged && value != null) {
                    flagged = false;
                    return value;
                }
            },
        };
    }

    container(player) {
        let vars = [],
            skills = player.body.skill,
            out = [],
            statnames = ["atk", "hlt", "spd", "str", "pen", "dam", "rld", "mob", "rgn", "shi", "min"];

        for (let i = 0; i < statnames.length; i++) {
            vars.push(this.floppy());
            vars.push(this.floppy());
            vars.push(this.floppy());
        }
        return {
            update: () => {
                let needsupdate = false,
                    i = 0;

                for (let j = 0; j < statnames.length; j++) {
                    let a = statnames[j];
                    vars[i++].update(skills.title(a));
                    vars[i++].update(skills.cap(a));
                    vars[i++].update(skills.cap(a, true));
                }

                for (let j = 0; j < vars.length; j++)
                    if (vars[j].publish() != null) needsupdate = true;
                if (needsupdate) {

                    for (let j = 0; j < statnames.length; j++) {
                        let a = statnames[j];
                        out.push(skills.title(a));
                        out.push(skills.cap(a));
                        out.push(skills.cap(a, true));
                    }
                }
            },

            publish: () => {
                if (out.length) {
                    let o = out.splice(0, out.length);
                    out = [];
                    return o;
                }
            },
        };
    }

    getstuff(s) {
        let val = '';

        val += s.amount("shi").toString(16).padStart(2, '0');
        val += s.amount("rgn").toString(16).padStart(2, '0');
        val += s.amount("mob").toString(16).padStart(2, '0');
        val += s.amount("rld").toString(16).padStart(2, '0');
        val += s.amount("dam").toString(16).padStart(2, '0');
        val += s.amount("pen").toString(16).padStart(2, '0');
        val += s.amount("str").toString(16).padStart(2, '0');
        val += s.amount("spd").toString(16).padStart(2, '0');
        val += s.amount("hlt").toString(16).padStart(2, '0');
        val += s.amount("atk").toString(16).padStart(2, '0');
        val += s.amount("min").toString(16).padStart(2, '0');
        return val;
    }

    update(gui) {
        let b = gui.master.body;

        if (!b) return 0;
        gui.bodyid = b.id;
        let dailyTank = null;

        gui.fps.update(Math.min(1, (global.fps / global.gameManager.roomSpeed / 1000) * 30));
        gui.color.update(gui.master.teamColor);
        gui.label.update(b.index);
        gui.score.update(JSON.stringify([b.skill.score, b.killCount.solo, b.killCount.assists, b.killCount.bosses]));
        gui.points.update(b.skill.points);

        let upgrades = [];
        let skippedUpgrades = [0];
        // Tutorial: if the current step does not teach evolving, hide the menu;
        // clickable tanks whose clicks are refused read as a broken game.
        const tutGate = Config.tutorial ? require('../tutorialSession.js') : null;
        const tutHideMenu = tutGate && (!tutGate.allows(b, 'upgrade') || tutGate.borrowing(b));
        for (let i = 0; i < b.upgrades.length; i++) {
            let upgrade = b.upgrades[i];
            if (tutHideMenu) continue;
            // A lesson can also pin the menu to one tank so the learner ends
            // up on the build the next lesson is written for.
            if (tutGate && !tutGate.upgradeAllowed(b, upgrade)) continue;
            if (b.skill.level >= b.upgrades[i].level) {
                upgrades.push(upgrade.branch.toString() + "_" + upgrade.branchLabel + "_" + upgrade.index);
            } else {
                if (upgrade.branch >= skippedUpgrades.length) {
                    skippedUpgrades[upgrade.branch] = 1;
                } else {
                    skippedUpgrades[skippedUpgrades.length - 1]++;
                }
            }
        }
        b.skippedUpgrades = skippedUpgrades;
        gui.upgrades.update(upgrades);

        if (Config.daily_tank) {
            if (b.skill.level >= Config.tier_multiplier * Config.daily_tank.tier && b.defs.includes(Config.spawn_class)) {
                dailyTank = Config.daily_tank_INDEX;
            }
            gui.dailyTank.update(JSON.stringify([dailyTank, Config.daily_tank.ads && !b.socket.status.daily_tank_watched_ad ? true : false]));
        } else gui.dailyTank.update(JSON.stringify([false]));

        gui.stats.update();
        gui.skills.update(this.getstuff(b.skill));

        gui.accel.update(b.acceleration);
        gui.topspeed.update(b.topSpeed);

        gui.root.update(b.rerootUpgradeTree);
        gui.class.update(b.label);
        gui.visibleName.update(b.settings.canSeeInvisible ? 1 : 0);
    }

    publish(gui) {
        let o = {
            fps: gui.fps.publish(),
            label: gui.label.publish(),
            score: gui.score.publish(),
            points: gui.points.publish(),
            upgrades: gui.upgrades.publish(),
            color: gui.color.publish(),
            statsdata: gui.stats.publish(),
            skills: gui.skills.publish(),
            accel: gui.accel.publish(),
            top: gui.topspeed.publish(),
            root: gui.root.publish(),
            class: gui.class.publish(),
            visibleName: gui.visibleName.publish(),
            dailyTank: gui.dailyTank.publish(),
        };

        let oo = [0];
        if (o.fps != null) {
            oo[0] += 0x0001;
            oo.push(o.fps || 1);
        }
        if (o.label != null) {
            oo[0] += 0x0002;
            oo.push(o.label);
            oo.push(o.color || gui.master.teamColor);
            oo.push(gui.bodyid);
        }
        if (o.score != null) {
            oo[0] += 0x0004;
            oo.push(o.score);
        }
        if (o.points != null) {
            oo[0] += 0x0008;
            oo.push(o.points);
        }
        if (o.upgrades != null) {
            oo[0] += 0x0010;
            oo.push(o.upgrades.length, ...o.upgrades);
        }
        if (o.statsdata != null) {
            oo[0] += 0x0020;
            oo.push(...o.statsdata);
        }
        if (o.skills != null) {
            oo[0] += 0x0040;
            oo.push(o.skills);
        }
        if (o.accel != null) {
            oo[0] += 0x0080;
            oo.push(o.accel);
        }
        if (o.top != null) {
            oo[0] += 0x0100;
            oo.push(o.top);
        }
        if (o.root != null) {
            oo[0] += 0x0200;
            oo.push(o.root);
        }
        if (o.class != null) {
            oo[0] += 0x0400;
            oo.push(o.class);
        }
        if (o.visibleName != null) {
            oo[0] += 0x0800;
            oo.push(o.visibleName);
        }
        if (o.dailyTank != null) {
            oo[0] += 0x1000;
            oo.push(o.dailyTank);
        }

        return oo;
    }

    newgui = (player) => {

        let gui = {
            master: player,
            fps: this.floppy(),
            label: this.floppy(),
            score: this.floppy(),
            points: this.floppy(),
            upgrades: this.floppy(),
            color: this.floppy(),
            skills: this.floppy(),
            topspeed: this.floppy(),
            accel: this.floppy(),
            stats: this.container(player),
            bodyid: -1,
            root: this.floppy(),
            class: this.floppy(),
            visibleName: this.floppy(),
            dailyTank: this.floppy(),
        };

        return {
            update: () => this.update(gui),
            publish: () => this.publish(gui),
        };
    };

    initalizePlayer(epackage, socket) {
        let name = epackage.name;
        let autoLVLup = epackage.autoLVLup;
        let transferbodyID = epackage.transferbodyID;
        let eastereggs = {
            braindamage: epackage.braindamagemode
        };

        socket.status.deceased = false;
        // Consume the request: a second 's' parks a fresh loop instead of
        // spawning a second body next to this one.
        socket.status.readyToSpawn = false;
        socket.status.readyToSpawn = true;

        if (this.players.indexOf(socket.player) != -1) { util.remove(this.players, this.players.indexOf(socket.player));  }

        if (global.gameManager.views.indexOf(socket.view) != -1) { util.remove(global.gameManager.views, global.gameManager.views.indexOf(socket.view)); socket.makeView(); }

        let spawn = true;

        if (transferbodyID) {
            let bodyInfo = global.travellingPlayers.find(i => i.id === transferbodyID);
            if (bodyInfo) {
                spawn = false;
                socket.player = socket.spawn(name);
                socket.player.body.importBody(bodyInfo);
                util.remove(global.travellingPlayers, global.travellingPlayers.indexOf(bodyInfo));
            }
        }
        if (spawn) {
            socket.player = socket.spawn(name);
            setTimeout(() => {

                if (!socket.player) return;
                if (eastereggs.braindamage) {
                    socket.player.body.orginFov = socket.player.body.FOV;
                    socket.player.body.eastereggs.braindamage = true;
                    let braindamageloop = setInterval(() => {
                        if (socket.player.body == null) return clearInterval(braindamageloop);
                        socket.player.body.facing = ran.randomAngle();
                        let stressFov = 0.5 + Math.floor(Math.random() * 2);
                        socket.player.body.FOV = stressFov * socket.player.body.orginFov;
                    }, 20)
                }
            }, 100)
            if (autoLVLup || Config.spawn_at_max_level) {
                if (!socket.player.body) return;
                while (socket.player.body.skill.level < Config.level_cap_cheat) {
                    socket.player.body.skill.score += socket.player.body.skill.levelScore;
                    socket.player.body.skill.maintain();
                    socket.player.body.refreshBodyAttributes();
                }
            }
        }

        // Reconnecting player: put their build, satchel and spot back now that
        // the level-45 fill above is done.
        if (Config.dig_royale && socket._resume) {
            try { require('../gamemodes/scripts/dig_royale.js').applyPendingResume(socket); } catch (e) { console.error('[RESUME]', e && e.message); }
        }
                util.log(`[INFO]: ${name == "" ? "An unnamed player" : name} has spawned into the game on team ${socket.player.body.team}! Players: ${this.players.length}`);

        socket.timeout.stop();
    }
    newPlayer(socket) {
        let { player, loc } = this.getSpawnLocation(socket.rememberedTeam);

        player.socket = socket;

        socket.camera.x = loc.x;
        socket.camera.y = loc.y;
        socket.camera.fov = 2000;
        socket.view.gazeUpon(true);
        socket.rememberedTeam = player.team;
        socket.player.loc = loc;
    }
    getSpawnLocation(rememberedTeam, name) {
        let player = {},
            loc = {};
        player.team = rememberedTeam;
        if (Config.clan_wars && name) {
            Config.clan_wars_ft.add(name);
            return { player: Config.clan_wars_ft.getPlayerInfo(name), loc: Config.clan_wars_ft.getSpawn(name) };
        }
        if (Config.mode == "tdm" || Config.tag) {
            let team = getWeakestTeam(global.gameManager);

            if (player.team == null || (player.team !== team && global.defeatedTeams.includes(player.team))) {
                player.team = team;
            }
        };
        if (global.spawnPoint) loc = global.spawnPoint;
        else loc = getSpawnableArea(player.team, global.gameManager);
        return { player, loc };
    }
    spawn = (socket, name) => {
        let { player, loc } = this.getSpawnLocation(socket.rememberedTeam, name);
        if (socket.player.loc && !global.spawnPoint && !Config.clan_wars) loc = socket.player.loc;

        // Tutorial: every learner owns a plot and always spawns in it, so the
        // outpost/vault/rock patch a lesson points at are always their own. This
        // skips forward respawns: a tutorial death returns you to your plot's start.
        let tutorialHome = null;
        if (Config.tutorial) {
            const session = require('../tutorialSession.js');
            session.claimPlot(socket);
            tutorialHome = session.spawnPointFor(socket);
            if (!tutorialHome) {
                // Every plot is occupied. Spawning anyway would place them by
                // the normal rules - inside another learner's plot.
                socket.talk("m", Config.popup_message_duration ?? 10000,
                    "The training ground is full right now - please try again in a minute.");
                socket.kick("Tutorial full.");
                return;
            }
            if (tutorialHome) {
                player.team = TEAM_BLUE;
                loc = tutorialHome;
                // Announce the plot immediately. The client treats receiving
                // this as proof it really is on the tutorial server - see the
                // auto-start gate in public/client/tutorial.js.
                session.talkPlotInfo(socket);
            }
        }

        if (!tutorialHome && !global.spawnPoint && !Config.clan_wars &&
            global.gameManager.terrainGrid && socket.lastDeathX !== undefined) {
            const pads = require('../terrain/outposts.js').ownedBy(player.team);
            if (pads.length) {
                const d2 = (x, y) => {
                    const dx = x - socket.lastDeathX, dy = y - socket.lastDeathY;
                    return dx * dx + dy * dy;
                };
                let bestD = d2(loc.x, loc.y), bestPad = null;
                for (const pad of pads) {
                    const d = d2(pad.x, pad.y);
                    if (d < bestD) { bestD = d; bestPad = pad; }
                }
                if (bestPad) {
                    const a = Math.random() * Math.PI * 2;
                    loc = { x: bestPad.x + Math.cos(a) * bestPad.r * 0.4,
                            y: bestPad.y + Math.sin(a) * bestPad.r * 0.4 };

                    global.gameManager.terrainGrid.pushCircleFromVoronoi(loc, 60);
                }
            }
        }

        // always spawn a fresh tank: a disconnected player's body is never handed
        // to a new socket
        const body = new Entity(loc);
        body.protect();
        body.isPlayer = true;
        body.define(Config.spawn_class);
        // Tutorial: learners are invisible to each other, and a leaderboard
        // listing strangers' names punches a hole in that. Nobody scores here.
        if (Config.tutorial) body.settings.leaderboardable = false;
        // tutorial: full dash charges and the ability HUD (raids do this in onHumanJoin)
        if (Config.tutorial) setImmediate(() => { try { require('../terrain/abilities.js').onSpawn(body); } catch (e) { /* */ } });
        if (Class.menu_tanks) {
            let string = Class.menu_tanks.UPGRADES_TIER_0[0];
            if (string !== "basic") {
                Class.menu_addons.UPGRADES_TIER_0.push("basic")
            }
        }
        body.name = name;
        accountBridge.applyIdentity(socket, body);
        body.incognito = socket.status.incognito ?? false;
        if (socket.permissions && socket.permissions.nameColor) {
            body.nameColor = socket.permissions.nameColor;
            socket.talk("z", body.nameColor);
        }
        body.become(player);
        socket.spectateEntity = null;
        socket.spectateKiller = null;
        socket.royaleWantsSpectate = false;
        body.invuln = true;
        player.body = body;
        body.socket = socket;
        body.hasOperator = socket.status.hasOperator;

        if (Config.dig_wars || Config.dig_royale) require('../terrain/gems.js').initSatchel(body);
        socket.status.daily_tank_watched_ad = false;
        socket.status.daily_tank_watched_ad_client = false;

        switch (Config.mode) {
            case 'tdm': {
                body.team = player.team;
                body.color.base = global.getTeamColor(player.body.team);
                socket.rememberedTeam = body.team;
                if (tutorialHome) {
                    // Tutorial: a Dig Royale palette colour, not team blue.
                    const c = require('../tutorialSession.js').learnerColor(socket);
                    body.color.base = c;
                    body.leaderboardColor = c;
                    body.minimapColor = c;
                    try {
                        const key = require('../terrain/outposts.js').ownerKeyFor(body);
                        if (key) require('../terrain/outposts.js').rebindOwner(key, body);
                    } catch (e) { }
                }
            } break;
            case 'tag': {
                body.team = player.team;
                body.color.base = global.getTeamColor(player.body.team);
                socket.rememberedTeam = body.team;
                Config.tag_data.addPlayer(body);
            } break;
            case 'clan': {
                body.team = player.team;
                body.originalName = body.name;
                body.clan = player.clan;
                body.color.base = getTeamColor(TEAM_RED);
                socket.rememberedTeam = body.team;
                Config.clan_wars_ft.add(name, body);
                if (!body.clan) {
                    let loop = setInterval(() => {
                    for (let e of Config.clan_wars_ft.getClans()) {
                            if (body.team !== e.team || body.team !== -101 || body.team !== -1 || body.team !== -2 || body.team !== -3 || body.team !== -4) {
                                clearInterval(loop);
                            } else body.team = getRandomTeam();
                        }
                    })
                }
            } break;
            default: {
                let team = getRandomTeam();
                // a reload coming back to its raid keeps its team and colour
                let kept = null;
                if (Config.dig_royale && !Config.royale_duos && socket._resume) {
                    try { kept = require('../gamemodes/scripts/dig_royale.js').resumeTeam(socket); } catch (e) { kept = null; }
                }
                // Duos: partners share one team (no friendly fire, one colour)
                if (Config.royale_duos) {
                    try { team = require('../duo/duoRaid.js').teamForSpawn(socket, name); } catch (e) { console.error('[DUO] team pick failed', e && e.stack || e); }
                } else if (Config.dig_royale) {
                    // Solo: a team id nobody else holds. A raw random id can land on
                    // a live bot's or player's, and then the two are a team (no
                    // damage between them, one colour, on each other's minimap).
                    if (kept) team = kept.team;
                    else try { team = require('../duo/duoRaid.js').freshTeamId(); } catch (e) { console.error('[ROYALE] team pick failed', e && e.stack || e); }
                }
                body.team = team;
                if (Config.dig_royale) {
                    // one palette colour per player, shared by hull, HUD, leaderboard and minimap
                    const c = kept ? kept.color : global.assignTeamColor(team);
                    body.color.base = c;
                    body.leaderboardColor = c;
                    body.minimapColor = c;
                } else body.color.base = Config.random_body_colors ?
                    ran.choose([ 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17 ]) : getTeamColor(TEAM_RED);
                let loop = setInterval(() => {
                    for (let e of entities.values()) {
                        if (body.team !== e.team || body.team !== -101 || body.team !== -1 || body.team !== -2 || body.team !== -3 || body.team !== -4) {
                            clearInterval(loop);
                        } else body.team = team;
                    }
                })
            }
        }
        this.preparePlayer(socket, player, body);
        if (Config.dig_royale) require('../gamemodes/scripts/dig_royale.js').onHumanJoin(body);
        socket.royaleNeedClick = false;
        return player;
    };

    preparePlayer(socket, player, body, doNotTakeAction = {}) {

        player._tcTeam = body.team;
        player.teamColor = new Color(ownTankColor(body)).compiled;

        player.target = { x: 0, y: 0 };

        player.command = {
            up: false,
            down: false,
            left: false,
            right: false,
            lmb: false,
            mmb: false,
            rmb: false,
            sidearm: false,
            autofire: false,
            autospin: false,
            override: false,
            autoalt: false,
            spinlock: false
        };

        if (!doNotTakeAction.dontOverrideRecords) {
            let begin = util.time();
            player.records = () => [
                global.gameManager.terrainGrid
                    ? ((socket && socket.gemDeathScore) !== undefined && socket.gemDeathScore !== null
                        ? socket.gemDeathScore
                        : (player.body.carriedGems | 0) + (((socket && socket.gemBanked) || 0) | 0))
                    : player.body.skill.score,
                Math.floor((util.time() - begin) / 1000),
                Config.respawn_delay,
                player.body.killCount.solo,
                player.body.killCount.assists,
                player.body.killCount.bosses,
                player.body.killCount.structures || 0,
                player.body.killCount.polygons,
                player.body.killCount.killers.length,
                ...(player.body.finalKillers || []).map(killer =>
                    killer && (killer.name || killer.label) ? (killer.name || killer.label) : "unknown"
                ),
                // appended after the variable-length killer list, so the client
                // reads it at m[9 + killerCount]
                player.body.rocksMined | 0,
                (socket && socket.gemDeathBanked !== undefined
                    ? socket.gemDeathBanked
                    : ((socket && socket.gemBanked) | 0)) | 0,
                (socket && socket.gemDeathCarried !== undefined
                    ? socket.gemDeathCarried
                    : (player.body.carriedGems | 0)) | 0,
                player.body.deathCause || "",
                (socket && socket.royalePlace) | 0,
                // raid extras: streak lost, drill tier lost, insured gems
                (socket && socket.raidDeathStreak) | 0,
                (socket && socket.raidDeathDrillLost) | 0,
                (socket && socket.gemDeathInsured) | 0,
                // raid: ms until the server lets you back in (3 s from the death)
                (socket && socket.royaleRespawnAt ? Math.max(0, socket.royaleRespawnAt - Date.now()) : 0) | 0,
            ];
        }

        player.gui = this.newgui(player);

        player.socket = socket;
        this.players.push(player);

        socket.camera.x = body.x;
        socket.camera.y = body.y;
        socket.camera.fov = 2000;

        socket.status.hasSpawned = true;

        if (!doNotTakeAction.dontSendWelcomeMessage) {
            let msg = Config.spawn_message.split("\n");
            for (let i = 0; i < msg.length; i++) {
                body.sendMessage(msg[i]);
            }
        }

        socket.talk("c", socket.camera.x, socket.camera.y, socket.camera.fov);

        socket.status.readyToBroadcast = true;
    }

    flatten(data) {
        let output = [data.type];
        if (data.type & 0x01) {
            output.push(
                 data.facing,
                 data.layer,
                 data.index,
                 data.color,
                 data.size,
                 data.realSize,
                 data.sizeFactor,
                 data.angle,
                 data.direction,
                 data.offset,
                 data.mirrorMasterAngle,
            );
        } else if (data.type & 0x10) {
            output.push(
                 data.id,
                 data.index,
                 data.x,
                 data.y,
                 data.vx,
                 data.vy,
                 data.size,
                 data.facing,
                 data.vfacing,
                 data.layer,
                 data.color,
                 Math.ceil(65535 * data.health),
                 Math.round(65535 * data.shield),
                 Math.round(255 * data.alpha),
                 // Hit feedback fields are appended AFTER alpha on purpose: perspective()
                 // rewrites this array by hardcoded index (alpha at 14 here, 18 below), so
                 // nothing may be inserted before it.
                 Math.round(255 * (data.hitFlash || 0)),
                 data.maxHealth || 0
            );
        } else {
            output.push(
                 data.id,
                 data.index,
                 data.x,
                 data.y,
                 data.vx,
                 data.vy,
                 data.size,
                 data.facing,
                 data.vfacing,
                 data.twiggle,
                 data.layer,
                 data.color,
                 data.borderless,
                 data.drawFill,
                 data.invuln,
                 Math.ceil(65535 * data.health),
                 Math.round(65535 * data.shield),
                 Math.round(255 * data.alpha),
                 Math.round(255 * (data.hitFlash || 0)),
                 data.maxHealth || 0
            );
            if (data.type & 0x04) {
                output.push(
                     data.name,
                     data.score,
                     data.digWarsGoal || "",
                     data.gemGlow || 0,
                     // [25] name style nid, [26] rank code, [27] skin nid
                     data.nameStyle || 0,
                     data.rankCode || 0,
                     data.skin || 0
                );
            }
        };

        output.push(data.guns.length);
        for (let i = 0; i < data.guns.length; i++) {
            const g = data.guns[i];
            output.push(
                g.time, g.power, g.color, g.alpha, g.strokeWidth,
                g.borderless, g.drawFill, g.drawAbove,
                g.length, g.width, g.aspect, g.angle, g.direction, g.offset
            );
        }

        output.push(data.turrets.length);
        for (let i = 0; i < data.turrets.length; i++) output.push(...this.flatten(data.turrets[i]));

        return output;
    }

    getInvisEntityAlpha(player, other, canSeeInvisible = false) {
        let alpha;
        if (player.body.id === other.master.id) {
            alpha = other.alpha ? other.alpha * 0.75 + 0.25 : 0.25;
        } else {
            if (canSeeInvisible) {
                alpha = other.alpha ? other.alpha * 0.55 + 0.45 : 0.45;
            } else if (!other.settings.fullyInvisible) {
                // a Smoke Bomb (abilities.js) only shows up close, and barely
                let range = other.smokeHidden ? 150 : 300;
                const peek = other.smokeHidden ? 0.18 : 0.45;
                if (!other.alpha) alpha = 1;
                let dist = Math.sqrt((player.body.x - other.x) ** 2 + (player.body.y - other.y) ** 2);
                if (dist >= range) {
                    alpha = other.alpha;
                } else {
                    const rangeAlpha = 1 - (dist / range);
                    alpha = other.alpha ? other.alpha + rangeAlpha * peek : rangeAlpha * peek;
                }
            } else alpha = other.alpha;
        }
        return alpha;
    }

    perspective(e, player, data) {
        if (player.body != null) {
            if (e.alpha < 1 && !e.limited && !player.body.settings.canSeeInvisible) {
                data[18] = Math.round(255 * this.getInvisEntityAlpha(player, e));
            }
            if (player.body.id === e.master.id) {
                data = data.slice();

                if (player._tcTeam !== player.body.team || !player.teamColor) {
                    player._tcTeam = player.body.team;
                    player.teamColor = new Color(ownTankColor(player.body)).compiled;
                }

                if (player.command.autospin) {
                    data[10] = 1;
                }
            }
            if (player.body.settings.canSeeInvisible) {
                data = data.slice();
                let alpha = this.getInvisEntityAlpha(player, e);
                if (e.limited) data[14] = Math.round(255 * alpha);
                else data[18] = Math.round(255 * alpha);
            }
            if (
                player.body.team === e.source.team &&
                (Config.groups || (Config.mode == 'ffa' || Config.mode == 'clan' && !Config.tag))
            ) {

                data = data.slice();
                if (e.limited) data[11] = player.teamColor;
                else data[12] = player.teamColor;
            }
        }
        return data;
    }

    generateMockup(index) {
        index = parseInt(index);
        let mock;

        let find = classMap.has(index) ? classMap.get(index) : null;
        if (find) {

            buildMockup(find, global.gameManager);

            mock = mockupData[mockupMap[index]];
        } else mock = null;

        return mock;
    }

    sendMockup(index, socket) {
        for (let splittedIndex of index.toString().split("-")) {
            if (socket.status.mockupData.receivedIndexes.includes(splittedIndex)) continue;

            let index = parseInt(splittedIndex);

            let mockup = mockupData[mockupMap[index]];
            if (!mockup) {
                mockup = this.generateMockup(index);
            }

            socket.talk("M", index, JSON.stringify(mockup));

            socket.status.mockupData.receivedMockups.push(mockup);

            socket.status.mockupData.receivedIndexes.push(splittedIndex);

            for (let turrets of mockup.turrets) {

                this.sendMockup(turrets.index, socket);
            }
            if (mockup.sendAllMockups) {

                for (let upgrades of mockup.upgrades) {
                    for (let i of upgrades.index.split("-")) {
                        this.sendMockupUpgrades(i, socket);
                    }
                }
            }
        }
    }

    sendMockupUpgrades(index, socket) {
        for (let splittedIndex of index.toString().split("-")) {
            if (socket.status.mockupData.receivedUpgradePackIndexes.includes(splittedIndex)) continue;
            this.sendMockup(index, socket);
            let parsedindex = parseInt(splittedIndex);
            let mockup = mockupData.find(o => o.index === `${parsedindex}`);
            if (!mockup) {
                let e = this.generateMockup(parsedindex);
                mockup = mockupData.find(o => o.index === `${e.index}`);
            }
            socket.status.mockupData.receivedUpgradePackMockups.push(mockup);
            socket.status.mockupData.receivedUpgradePackIndexes.push(splittedIndex);
            for (let { index } of mockup.upgrades) {
                for (let i of index.toString().split("-")) this.sendMockupUpgrades(i, socket);
            }
        }
    }

    eyes(socket) {
        const check = (camera, obj) => {
            let fov = global.gameManager.arenaClosed ? 1.6 : 1;
            return Math.abs(obj.x - camera.x) < camera.fov * fov + 1.5 * obj.size + 100 &&
                Math.abs(obj.y - camera.y) < camera.fov * fov * 0.5625 + 1.5 * obj.size + 100;
        };
        let lastVisibleUpdate = 0;
        let nearby = new Map();
        let o = {
            socket,
            getNearby: () => nearby,
            add: e => { if (check(socket.camera, e)) nearby.set(e.id, e); },
            remove: e => { nearby.delete(e.id) },
            check: (e) => { return check(socket.camera, e); },
            gazeUpon: (updateCam = false) => {
                // Flow control. Snapshots are full state, so one the player cannot take yet
                // is better skipped than queued; otherwise stale snapshots pile up in the
                // socket and proxy and every ping and input waits behind them. The client
                // acks each snapshot with 'd'; allow about one base round trip in flight
                // plus slack, and never go silent for more than a second.
                const flow = socket.flow, nowFlow = util.time();
                if (!updateCam && flow.sent.length &&
                    nowFlow - flow.sent[0] > (flow.rttMin ?? 300) + FLOW_SLACK_MS &&
                    nowFlow - flow.lastSentAt < 1000) {
                    flow.skipped++;
                    return;
                }
                logs.network.set();

                let lastCycle = global.gameManager.room.lastCycle;

                socket.camera.lastUpdate = lastCycle;

                socket.status.receiving++;

                let player = socket.player,
                    camera = socket.camera,
                    fovNow = camera.fov;

                if (player.body != null) {

                    if (player.body.isDead()) {
                        let purge = () => player.body = null;
                        if (player.body.store && player.body.store.dragInterval) {
                            clearInterval(player.body.store.dragInterval);
                            delete player.body.store.dragInterval;
                        }
                        let die = () => {
                            socket.status.deceased = true;

                            if (Config.clan_wars) Config.clan_wars_ft.remove(player.body);

                            socket.lastDeathX = player.body.x;
                            socket.lastDeathY = player.body.y;

                            if (Config.dig_royale) {
                                try {
                                    const dr = require('../gamemodes/scripts/dig_royale.js');
                                    dr.onCombatantDead(player.body);
                                    if (dr.markHumanDeath) dr.markHumanDeath(socket);
                                } catch (e) { /* */ }
                                socket.royaleNeedClick = false;
                                socket.status.readyToSpawn = true;
                            }

                            socket.spectateKiller = livingSpectateTarget(player.body.finalKillers, !!Config.dig_royale);
                            socket.spectateEntity = socket.spectateKiller;
                            // Raid: freeze on the corpse until Spectate is pressed.
                            if (Config.dig_royale) {
                                socket.royaleWantsSpectate = false;
                                socket.camera.x = socket.lastDeathX;
                                socket.camera.y = socket.lastDeathY;
                                // Environmental deaths (storm, rock crush, base)
                                // have no killer: clear any stale attacker so
                                // the death cam stays near the corpse instead
                                // of jumping to a lookalike across the map.
                                const dc = player.body.deathCause;
                                if (dc === "storm" || dc === "rock" || dc === "base" || dc === "raidend") {
                                    socket.spectateKiller = null;
                                    socket.spectateEntity = null;
                                }
                            }

                            socket.talk("F", ...player.records());
                            // the ranked life result, settled a moment ago
                            try { accountBridge.afterDeathPacket(socket); } catch (e) { /* */ }
                            purge();

                            socket.timeout.start();
                        }
                        if (player.body.master.label == "Bacteria") {
                            let exit = () => die();
                            let newgui = (player) => this.newgui(player);
                            becomeBulletChildren(socket, player, exit, newgui);
                        } else die();
                    } else if (player.body.photo) {

                        let x = player.body.cameraOverrideX === null ? player.body.photo.x : player.body.cameraOverrideX,
                            y = player.body.cameraOverrideY === null ? player.body.photo.y : player.body.cameraOverrideY;

                        camera.x = x;
                        camera.y = y;
                        camera.vx = player.body.photo.vx;
                        camera.vy = player.body.photo.vy;
                        camera.scoping = player.body.cameraOverrideX !== null;

                        fovNow = player.body.fov;

                        player.viewId = player.body.id;
                    }
                }
                if (player.body == null) {
                    fovNow = 2000;
                    camera.scoping = false;

                    const holdCorpse = Config.dig_royale && !socket.royaleWantsSpectate;
                    if (holdCorpse) {
                        if (socket.lastDeathX != null) camera.x = socket.lastDeathX;
                        if (socket.lastDeathY != null) camera.y = socket.lastDeathY;
                    } else {
                        let hops = 0;
                        while (socket.spectateEntity && socket.spectateEntity.isDead() && hops++ < 8) {
                            socket.spectateEntity = livingSpectateTarget(socket.spectateEntity.finalKillers);
                        }
                        // duos: when the watched tank goes down, your partner first
                        if ((!socket.spectateEntity || socket.spectateEntity.isDead()) && Config.royale_duos) {
                            const mb = require('../duo/duoRaid.js').mateOfSocketBody(socket);
                            if (mb) socket.spectateEntity = mb;
                        }
                        if (!socket.spectateEntity || socket.spectateEntity.isDead()) {
                            const lx = socket.spectateEntity ? socket.spectateEntity.x : camera.x;
                            const ly = socket.spectateEntity ? socket.spectateEntity.y : camera.y;
                            nearestSpectate(socket, lx, ly);
                        }
                        if (socket.spectateEntity && !socket.spectateEntity.isDead()) {
                            camera.x = socket.spectateEntity.x;
                            camera.y = socket.spectateEntity.y;
                            // see what they see: a giant's wide view, not the default
                            const sf = socket.spectateEntity.fov;
                            if (sf > 0 && isFinite(sf)) fovNow = Math.max(1000, sf);
                        } else {
                            // nobody left to watch: sit on the safe circle, don't drift
                            const park = spectateParkSpot();
                            if (park) { camera.x = park.x; camera.y = park.y; }
                        }
                    }
                }

                camera.fov += Math.max((fovNow - camera.fov) / 30, fovNow - camera.fov);

                if (camera.lastUpdate - lastVisibleUpdate > Config.visible_list_interval) {
                    lastVisibleUpdate = camera.lastUpdate;
                    nearby.clear();
                    const camFovBroad = camera.fov * (global.gameManager.arenaClosed ? 1.6 : 1);
                    const extra = 800;
                    const camXBound = camFovBroad + 100 + extra;
                    const camYBound = camFovBroad * 0.5625 + 100 + extra;
                    const g = global.grid;
                    if (g) {
                        const found = g.query(
                            camera.x - camXBound,
                            camera.y - camYBound,
                            camera.x + camXBound,
                            camera.y + camYBound
                        );
                        for (let i = 0; i < found.length; i++) {
                            nearby.set(found[i].id, found[i]);
                        }
                    } else {
                        for (const entity of entities.values()) {
                            if (Math.abs(entity.x - camera.x) < camXBound - extra + 1.5 * entity.size &&
                                Math.abs(entity.y - camera.y) < camYBound - extra + 1.5 * entity.size) {
                                nearby.set(entity.id, entity);
                            }
                        }
                    }
                }

                let visible = [];

                const camX = camera.x, camY = camera.y, camFov = camera.fov;
                const limitDistance = 1.5;
                const fovDiv = camFov / limitDistance;
                const fovDivY = fovDiv * (9 / 13);

                const mockupsToSend = new Set();

                for (const entity of nearby.values()) {

                    if (entity.photo &&
                        Math.abs(entity.x - camX) < fovDiv + 1.5 * entity.size &&
                        Math.abs(entity.y - camY) < fovDivY + 1.5 * entity.size
                    ) {

                        if (!Config.load_all_mockups && entity.index) {
                            mockupsToSend.add(entity.index);
                            // runtime-attached turrets/props (gem satchels,

                            if (entity.turrets) {
                                for (const t of entity.turrets.values()) {
                                    if (t.index) mockupsToSend.add(t.index);
                                }
                            }
                            if (entity.props) {
                                for (const p of entity.props.values()) {
                                    if (p.index) mockupsToSend.add(p.index);
                                }
                            }
                        }

                        if (!entity.flattenedPhoto) {
                            entity.flattenedPhoto = this.flatten(entity.photo);
                        }

                        // a Smoke Bomb hides the tank (and its drones) from anyone
                        // outside the cloud: not even sent (abilities.js smokeView)
                        const smoked = entity.smokeHidden ? entity : entity.master && entity.master !== entity && entity.master.smokeHidden && entity.type !== "bullet" ? entity.master : null;
                        if (smoked) {
                            const sa = (smokeAbil || (smokeAbil = require('../terrain/abilities.js'))).smokeView(player.body, smoked);
                            if (sa < 0) continue;
                            const sd = this.perspective(entity, player, entity.flattenedPhoto).slice();
                            sd[entity.limited ? 14 : 18] = Math.round(255 * sa);
                            visible.push(sd);
                            continue;
                        }
                        visible.push(this.perspective(entity, player, entity.flattenedPhoto));
                    }
                }

                if (!Config.load_all_mockups && mockupsToSend.size > 0) {
                    for (const index of mockupsToSend) {
                        this.sendMockup(index, socket);
                    }
                }

                const view = [];
                for (let i = 0; i < visible.length; i++) {
                    const src = visible[i];
                    for (let j = 0, n = src.length; j < n; j++) view.push(src[j]);
                }
                if (!Config.load_all_mockups) {
                    for (let upgrade of (player.body?.upgrades || [])) {
                        if (player.body.skill.level >= upgrade.level) {
                            this.sendMockup(upgrade.index, socket);
                        }
                    }
                }
                if (updateCam) {
                    socket.talk(
                        "u",
                        true,
                        camera.x,
                        camera.y,
                    );
                } else {

                    player.gui.update();

                    socket.talk(
                        "u",
                        lastCycle,
                        camera.x,
                        camera.y,
                        fovNow,
                        camera.vx,
                        camera.vy,
                        camera.scoping,
                        ...player.gui.publish(),
                        visible.length,
                        ...view
                    );
                    flow.sent.push(lastCycle);
                    if (flow.sent.length > 120) flow.sent.shift();
                    flow.lastSentAt = nowFlow;
                }
                logs.network.mark();
            },
        };
        global.gameManager.views.push(o);
        return o;
    }

    deltaHandler = (() => {
        const Delta = class {
            constructor(dataLength, finder) {
                this.dataLength = dataLength;
                this.finder = finder;
                this.data = [];
            }
            update(id = 0, ...args) {
                if (!this.data[id]) this.data[id] = this.finder([]);
                let old = this.data[id];
                let now = this.finder(args);
                this.data[id] = now;
                this.now = now;
                let oldIndex = 0;
                let nowIndex = 0;
                let updates = [];
                let updatesLength = 0;
                let deletes = [];
                let deletesLength = 0;
                while (oldIndex < old.length && nowIndex < now.length) {
                    let oldElement = old[oldIndex];
                    let nowElement = now[nowIndex];
                    if (oldElement.id === nowElement.id) {

                        nowIndex++;
                        oldIndex++;
                        let updated = false;
                        for (let i = 0; i < this.dataLength; i++)
                            if (oldElement.data[i] !== nowElement.data[i]) {
                                updated = true;
                                break;
                            }
                        if (updated) {
                            updates.push(nowElement.id, ...nowElement.data);
                            updatesLength++;
                        }
                    } else if (oldElement.id < nowElement.id) {

                        deletes.push(oldElement.id);
                        deletesLength++;
                        oldIndex++;
                    } else {

                        updates.push(nowElement.id, ...nowElement.data);
                        updatesLength++;
                        nowIndex++;
                    }
                }
                for (let i = oldIndex; i < old.length; i++) {
                    deletes.push(old[i].id);
                    deletesLength++;
                }
                for (let i = nowIndex; i < now.length; i++) {
                    updates.push(now[i].id, ...now[i].data);
                    updatesLength++;
                }
                let reset = [0, now.length],
                    update = [deletesLength, ...deletes, updatesLength, ...updates];
                for (let element of now) reset.push(element.id, ...element.data);
                return { update, reset };
            }
        };

        let isGemMode = () => !!global.gameManager.terrainGrid;
        let lbValue = (ent) => isGemMode()
            ? (ent.carriedGems | 0) + (((ent.socket ? Math.max(0, (ent.socket.gemBanked || 0) - (ent.socket.bankKept | 0)) : ent.botBanked) || 0) | 0)
            : ent.skill.score;
        let makeLeaderboardList = (list, args) => {
            let topTen = [];
            for (let i = 0; i < 10 && list.length; i++) {
                let top,
                    is = -1;
                for (let j = 0; j < list.length; j++) {
                    let val = lbValue(list[j]);
                    if (val > is) {
                        is = val;
                        top = j;
                    }
                }

                if (top === undefined || (is === 0 && !isGemMode())) break;
                let entry = list[top];
                let color = entry.leaderboardColor ? entry.leaderboardColor + " 0 1 0 false"
                    : Config.groups || (Config.mode == 'ffa' && !Config.tag) ? '11 0 1 0 false'
                    : entry.color.compiled;
                topTen.push({
                    id: entry.id,
                    data: [
                        Math.round(lbValue(entry)),
                        entry.index,
                        entry.name,
                        entry.leaderboardColor ? color : Config.mode == 'ffa' && !Config.tag ? '12 0 1 0 false' : color,
                        color,
                        entry.nameColor || "#FFFFFF",
                        entry.label,
                        entry.settings.renderOnLeaderboard ?? true,
                    ],
                });
                list.splice(top, 1);
            }
            global.gameManager.room.topPlayerID = topTen.length ? topTen[0].id : -1;
            return topTen.sort((a, b) => a.id - b.id);
        }
        let makeLeaderboardHPList = (list) => {
            let topTen = [];
            for (let i = 0; i < 10 && list.length; i++) {
                let top,
                    is = 0;
                for (let j = 0; j < list.length; j++) {
                    let val = list[j].skill.score;
                    if (val > is) {
                        is = val;
                        top = j;
                    }
                }
                if (is === 0) break;
                let entry = list[top];
                topTen.push({
                    id: entry.id + 100,
                    data: [
                        Math.round((entry.health.amount / entry.health.max) * 100),
                        entry.index.toString(),
                        entry.name === "" ? entry.label : entry.name,
                        entry.color.compiled,
                        entry.color.compiled,
                        "#ffffff",
                        Class.hp.LABEL,
                        false,
                    ]
                });
                list.splice(top, 1);
            }
            global.gameManager.room.topPlayerID = topTen.length ? topTen[0].id : -1;
            return topTen.sort((a, b) => a.id - b.id);
        }

        let minimapAll = new Delta(5, args => {
            let all = [];
            for (const my of entities.values()) {
                if (my.allowedOnMinimap && (
                    my.alwaysShowOnMinimap ||
                    (my.type === "wall" && my.alpha > 0.2) ||
                    my.type === "miniboss" || my.type == "portal" ||
                    my.isMothership
                )) {
                    const x = Config.blackout ? Math.floor(Math.random() * global.gameManager.room.width - global.gameManager.room.width / 2) : my.x;
                    const y = Config.blackout ? Math.floor(Math.random() * global.gameManager.room.height - global.gameManager.room.height / 2) : my.y;
                    all.push({
                        id: my.id,
                        data: [
                            Config.blackout ? 0 : my.type === "wall" || my.isMothership ? my.shape === 4 ? 2 : 1 : 0,
                            util.clamp(Math.floor((256 * x) / global.gameManager.room.width), -128, 127),
                            util.clamp(Math.floor((256 * y) / global.gameManager.room.height), -128, 127),
                            Config.blackout ? Config.blackout_minimap_color + " 0 1 0 false" : my.minimapColor ? my.minimapColor + " 0 1 0 false" : my.color.compiled,
                            Math.round(my.SIZE),
                        ],
                    });
                }
            }
            return all;
        });
        let minimapTeams = new Delta(3, args => {
            let all = [];
            // Tutorial: every learner is on TEAM_BLUE, so the team minimap would show
            // them to each other across arenas they cannot reach. args[1] is the
            // viewer's arena; anything outside it is filtered out.
            const plot = args[1];
            const tutPlots = Config.tutorial ? require('../terrain/tutorialPlots.js') : null;
            for (const my of entities.values())
                if (my.type === "tank" && my.team === args[0] && my.master === my && my.allowedOnMinimap) {
                    if (tutPlots && tutPlots.plotAt(my.x, my.y) !== plot) continue;
                    all.push({
                        id: my.id,
                        data: [
                            util.clamp(Math.floor((256 * my.x) / global.gameManager.room.width), -128, 127),
                            util.clamp(Math.floor((256 * my.y) / global.gameManager.room.height), -128, 127),
                            my.minimapColor ? my.minimapColor + " 0 1 0 false" : Config.groups || (Config.mode == 'ffa' || Config.mode == 'clan' && !Config.tag) ? '10 0 1 0 false' : my.color.compiled,
                        ],
                    });
                }
            return all;
        });
        let minimapAllTeams = new Delta(3, args => {
            let all = [];
            for (const my of entities.values())
                if (my.type === "tank" && my.master === my && !my.lifetime) {
                    all.push({
                        id: my.id,
                        data: [
                            util.clamp(Math.floor((256 * my.x) / global.gameManager.room.width), -128, 127),
                            util.clamp(Math.floor((256 * my.y) / global.gameManager.room.height), -128, 127),
                            my.minimapColor ? my.minimapColor + " 0 1 0 false" : Config.groups || (Config.mode == 'ffa' || Config.mode == 'clan' && !Config.tag) ? '12 0 1 0 false' : my.color.compiled,
                        ],
                    });
                }
            return all;
        });
        let globalLeaderboard = new Delta(7, args => {
            let list = [];
            if (Config.tag) {
                let teams = Config.tag_data.getData();
                for (let i = 0; i < teams.length; i++) {
                  list.push({
                    id: i,
                    data: [
                      teams[i],
                      Class.tagMode.index.toString(),
                      teamNames[i],
                      getTeamColor(-i - 1, true),
                      getTeamColor(-i - 1, true),
                      "#ffffff",
                      Class.tagMode.LABEL,
                      false,
                    ],
                  });
                }
                return list;
            }
            if (Config.mothership) {
                let teams = Config.mothership_data.getData();
                for (let i = 0; i < teams.length; i++) {
                    let m = teams[i];
                    if (!m.isDead()) {
                        list.push({
                            id: m.id,
                            data: [
                                Math.round((m.health.amount / m.health.max) * 100),
                                m.index.toString(),
                                teamNames[i],
                                getTeamColor(-i - 1, true),
                                getTeamColor(-i - 1, true),
                                "#ffffff",
                                Class.hp.LABEL,
                                false,
                            ]
                        });
                    }
                }
                return list;
            }
            for (let instance of entities.values()) {
                if (instance.settings.leaderboardable &&
                    instance.settings.drawShape &&
                    !instance.incognito &&
                    (Config.bots_count_on_scoreboard || !instance.isBot) &&
                    (instance.type === "tank" ||
                     instance.killCount.solo ||
                     instance.killCount.assists
                    )
                ) list.push(instance);
            }
            return makeLeaderboardList(list, args);
        });
        let defaultLeaderboard = new Delta(7, args => {
            let list = [];
            for (const instance of entities.values()) {
                if (instance.settings.leaderboardable &&
                    instance.settings.drawShape &&
                    !instance.incognito &&
                    (Config.bots_count_on_scoreboard || !instance.isBot) &&
                    instance.type !== "food" &&
                    (instance.type === "tank" ||
                     instance.killCount.solo ||
                     instance.killCount.assists
                    )
                ) list.push(instance);
            }
            return makeLeaderboardList(list, args);
        });
        let playerLeaderboard = new Delta(7, args => {
            let list = [];
            for (const instance of entities.values()) {
                if (
                    instance.isPlayer &&
                    !instance.incognito &&
                    instance.settings.leaderboardable &&
                    instance.settings.drawShape
                ) list.push(instance);
            }
            return makeLeaderboardList(list, args);
        })
        let bossLeaderboard = new Delta(7, args => {
            let list = [];
            for (const instance of entities.values()) {
                if (
                    (instance.isBoss ||
                     instance.type == "miniboss"
                    ) &&
                    instance.settings.leaderboardable &&
                    instance.settings.drawShape
                ) list.push(instance);
            }
            return makeLeaderboardHPList(list);
        })
        let subscribers = [];
        setInterval(() => {
            logs.minimap.set();
            let minimapUpdate = minimapAll.update(),
                leaderboardUpdate,
                minimapAllTeamsUpdate = minimapAllTeams.update(),
                minimapTeamUpdates;
            // Dig Wars war score: each team's total banked gemdust, shown as
            // the top-center bar on every client.
            let bankBlue = 0, bankRed = 0;
            const gemMode = !!global.gameManager.terrainGrid;
            const royaleMode = !!Config.dig_royale;
            if (gemMode) {
                for (const s of this.clients) {
                    if (!s.player) continue;
                    const t = s.player.body ? s.player.body.team : s.player.team;
                    const b = (s.gemBanked || 0) | 0;
                    if (t === TEAM_BLUE) bankBlue += b;
                    else if (t === TEAM_RED) bankRed += b;
                }
                for (const b of global.gameManager.gameHandler.bots) {
                    if (b.isDead()) continue;
                    if (b.team === TEAM_BLUE) bankBlue += (b.botBanked || 0) | 0;
                    else if (b.team === TEAM_RED) bankRed += (b.botBanked || 0) | 0;
                }
            }
            // Teammate positions + names for the map overlays, per team.
            let tmBlue = [], tmRed = [];
            if (gemMode) {
                for (const s of this.clients) {
                    const b = s.player && s.player.body;
                    if (!b || s.status.deceased) continue;
                    const rec = [b.id, b.name || "", Math.round(b.x), Math.round(b.y)];
                    if (b.team === TEAM_BLUE) tmBlue.push(rec);
                    else if (b.team === TEAM_RED) tmRed.push(rec);
                }
                for (const b of global.gameManager.gameHandler.bots) {
                    if (b.isDead()) continue;
                    const rec = [b.id, b.name || "", Math.round(b.x), Math.round(b.y)];
                    if (b.team === TEAM_BLUE) tmBlue.push(rec);
                    else if (b.team === TEAM_RED) tmRed.push(rec);
                }
            }
            // Leader arrow: the #1 player's live position, resolved once per

            let leaderID = -1, leaderX = 0, leaderY = 0, leaderTeam = 0;
            {
                const topId = global.gameManager.room.topPlayerID;
                const leader = topId !== -1 ? entities.get(topId) : null;
                if (leader) {
                    leaderID = topId;
                    leaderX = Math.round(leader.x);
                    leaderY = Math.round(leader.y);
                    leaderTeam = leader.team | 0;   
                }
            }

            const opState = gemMode ? JSON.stringify(
                require('../terrain/outposts.js').stateSnapshot()) : null;

            const ccState = gemMode ? JSON.stringify(
                require('../terrain/coreChambers.js').stateSnapshot()) : null;
            for (let socket of subscribers) {
                minimapTeamUpdates = minimapTeams.update(
                    socket.id,
                    socket.player.body ? socket.player.body.team : socket.player.team,
                    Config.tutorial ? require('../tutorialSession.js').plotOf(socket) : null);
                if (!socket.status.selectedLeaderboard) socket.status.selectedLeaderboard = "global";
                if (!socket.status.hasSpawned || socket.status.selectedLeaderboard == "stop") continue;
                let sl = socket.status.selectedLeaderboard;
                let getLeaderboard =
                sl == "global" ? globalLeaderboard :
                sl == "default" ? defaultLeaderboard :
                sl == "players" ? playerLeaderboard :
                sl == "bosses" ? bossLeaderboard :
                globalLeaderboard;

                leaderboardUpdate = getLeaderboard.update(
                    socket.id,
                    (Config.groups || (Config.mode == 'ffa' && !Config.tag)) && socket.player.body ? socket.player.body.id : null
                );
                let team = socket.status.seesAllTeams ? minimapAllTeamsUpdate : minimapTeamUpdates;

                if (global.gameManager.gameHandler.active) {
                    for (let e of getLeaderboard.now) {
                        this.sendMockup(e.data[1], socket);
                    }
                }

                if (socket.status.needsNewBroadcast) {
                    socket.talk("RM");
                    socket.talk(
                      "b",
                      ...minimapUpdate.reset,
                      ...(team ? team.reset : [0, 0]),
                      ...(socket.anon ? [0, 0] : leaderboardUpdate.reset)
                    );
                    socket.status.needsNewBroadcast = false;
                } else {
                    socket.talk(
                      "b",
                      ...minimapUpdate.update,
                      ...(team ? team.update : [0, 0]),
                      ...(socket.anon ? [0, 0] : leaderboardUpdate.update)
                    );
                }
                if (socket.status.forceNewBroadcast) {
                    socket.talk("RM");
                    socket.talk("RL");
                    socket.status.needsNewBroadcast = true;
                }
                socket.talk("LA", leaderID, leaderX, leaderY, leaderTeam);
                if (gemMode) {
                    if (!royaleMode) {
                    socket.talk("TB", bankBlue, bankRed);
                    const myTeam = socket.player && (socket.player.body ? socket.player.body.team : socket.player.team);
                    const tm = myTeam === TEAM_RED ? tmRed : tmBlue;
                    socket.talk("TM", tm.length, ...tm.flat());
                    }
                    if (opState) socket.talk("OP", opState);
                    if (ccState && !royaleMode) socket.talk("CC", ccState);
                }
            }
            logs.minimap.mark();
            let time = performance.now();
            for (let socket of this.clients) {
                // five minutes dead: out. Not in a raid, where the idle kick
                // (dig_royale tickDeadIdle) watches the death card instead and
                // an active spectator may stay
                if (socket.timeout.check(time) && !(Config.dig_royale && !Config.tutorial)) socket.lastWords("K");
                if (time - socket.statuslastHeartbeat > Config.max_heartbeat_interval) socket.kick("Lost heartbeat.");
            }
        }, 250);
        const broadcast = {
            add: socket => subscribers.push(socket),
            remove: socket => {
                let i = subscribers.indexOf(socket);
                if (i !== -1) util.remove(subscribers, i);
            },
        };
        return {
            subscribe: (socket) => broadcast.add(socket),
            unsubscribe: (socket) => broadcast.remove(socket),
        }
    })();

    sendToServer(socket, server) {
        if (!socket.player?.body || socket.status.transferred) return;
        socket.status.transferred = true;
        let id = Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, "0");
        fetch(`${server}/api/sendPlayer`, {
            method: "POST",
            body: JSON.stringify({
                key: process.env.API_KEY,
                id: id,
                name: socket.player.body.name,
                definition: socket.player.body.defs.map(d => Object.keys(Class).find(k => Class[k] === d) || d),
                score: socket.player.body.skill.score,
                killCount: socket.player.body.killCount,
                level: socket.player.body.skill.level,
                skillcap: socket.player.body.skill.caps,
                skill: socket.player.body.skill.raw,
                points: socket.player.body.skill.points,
            }),
        }).then(async (r) => {
            if (r.status === 200) {
                socket.talk("t", server.replace("http://", "").replace("https://", ""), id);
            }
        }).catch(e => {
            console.log(e);
            socket.status.transferred = false;
        });
    };

    connect(socket, req) {
        util.log(`[INFO]: A client wants to connect...`);
        socket.player = { camera: {} };
        socket.nearby = [];
        socket.spectateEntity = null;
        socket.id = crypto.randomUUID();
        socket.binaryType = "arraybuffer";
        socket.onerror = () => {};
        socket.spawn = (name) => this.spawn(socket, name);
        socket.onerror = () => {};
        socket.kick = (reason) => {
            util.warn(reason + " Kicking.");
            socket.close();
        };
        socket.talk = (...message) => {
            if (socket.readyState === socket.OPEN) {
                socket.send(protocol.encode(message), { binary: true });
            }
        };
        socket.ban = (reason) => this.ban(socket, reason);
        socket.permaban = (reason) => this.permaban(socket, reason);
        socket.lastWords = (...message) => {
            if (socket.readyState === socket.OPEN) {
                socket.send(protocol.encode(message), { binary: true, });
                socket.terminate();
            }
        };
        socket.on("close", () => {
            socket.loops.terminate();
            this.close(socket);
        });
        socket.initMockupList = () => {
            return {
                receivedIndexes: [],
                receivedMockups: [],
                receivedUpgradePackIndexes: [],
                receivedUpgradePackMockups: [],
                requestMockups: [],
            }
        }
        socket._seenAt = Date.now();
        socket.on("pong", () => { socket._seenAt = Date.now(); });
        socket.messageManager = socket.on("message", message => {
            socket._seenAt = Date.now();
            try {
                this.incoming(message, socket);
            } catch (e) {
                console.error("[PACKET ERROR] " + ((e && e.stack) || e));
            }
        });
        socket.connectedTo = global.gameManager.name;
        let timer = 0;
        socket.timeout = {
            check: (time) => timer && time - timer > Config.max_heartbeat_interval,
            start: () => {
                timer = performance.now();
            },
            stop: () => {
                timer = 0;
            }
        };
        socket.awaiting = {};
        socket.awaitResponse = function (options, callback) {
            socket.awaiting[options.packet] = {
                callback: callback,
                timeout: setTimeout(() => {
                    console.log("Socket did not respond to the eval packet, kicking...");
                    socket.kick("Did not comply with the server's protocol.");
                }, options.timeout),
            };
        };
        socket.resolveResponse = function (id, packet) {
            if (socket.awaiting[id]) {
                clearTimeout(socket.awaiting[id].timeout);
                socket.awaiting[id].callback(packet);
                return true;
            }
            return false;
        };

        socket.status = {
            verified: false,
            receiving: 0,
            deceased: true,
            requests: 0,
            hasSpawned: false,
            needsFullMap: true,
            needsNewBroadcast: true,
            forceNewBroadcast: false,
            selectedLeaderboard: false,
            seesAllTeams: false,
            daily_tank_watched_ad: false,
            readyToSpawn: true,
            hasOperator: false,
            readyToBroadcast: false,
            mockupData: socket.initMockupList(),
            lastHeartbeat: util.time(),
        };

        let nextUpdateCall = null;
        let trafficMonitoring = setInterval(() => this.traffic(socket), 1500);
        this.deltaHandler.subscribe(socket);
        socket.loops = {
            setUpdate: (timeout) => {
                nextUpdateCall = timeout;
            },
            cancelUpdate: () => {
                clearTimeout(nextUpdateCall);
            },
            terminate: () => {
                clearTimeout(nextUpdateCall);
                clearTimeout(trafficMonitoring);
                this.deltaHandler.unsubscribe(socket);
            },
        };

        socket.camera = {
            x: 0,
            y: 0,
            vx: 0,
            vy: 0,
            lastUpdate: performance.now(),
            lastDowndate: undefined,
            scoping: false,
            fov: 2000,
        };

        socket.flow = { sent: [], rttMin: null, rttMinAt: 0, lastSentAt: 0, skipped: 0 };
        socket.makeView = () => { socket.view = this.eyes(socket); };
        socket.makeView();

        // X-Forwarded-For is only believed from TRUSTED_PROXIES (lib/clientIp.js).
        socket.ip = clientIp(req);
        if (!socket.ip) {
            return socket.kick("Missing IP.");
        }

        try {
            if (fs.existsSync(PERMABAN_FILE)) {
                permBans = JSON.parse(fs.readFileSync(PERMABAN_FILE));
                if (permBans.some(b => b.ip === socket.ip)) {
                    socket.talk("permanentban");
                    socket.kick("Permanent Banned player found!");
                    return;
                }
            }
        } catch (e) {
            console.error("Error checking permabans:", e);
        }

        util.log("[INFO]: New socket opened with ip " + socket.ip);

        // session cookie -> socket.account; kicks an older tab of the same
        // account, or this socket if the account is banned
        try { accountBridge.onConnect(socket, req, this); } catch (e) {
            console.error("[accounts] connect failed: " + ((e && e.stack) || e));
        }
        if (socket.readyState !== socket.OPEN) return;

        this.clients.push(socket);

        if (!global.gameManager.parentPort) {
            for (let i = 0; i < global.servers.length; i++) {
                let server = global.servers[i];
                if (server.gameManager) server.players++;
            }
        } else {
            global.gameManager.parentPort.postMessage([true, global.gameManager.reportedPlayerCount()]);
        }
        util.log(`[INFO]: Client has been welcomed!`);

        if (Config.load_all_mockups) {
            for (let i = 0; i < mockupData.length; i++) {
                socket.talk("M", mockupData[i].index, JSON.stringify(mockupData[i]));
            }
        }

        if (Config.daily_tank && !Array.isArray(Config.daily_tank)) {
            const tank = ensureIsClass(Config.daily_tank.tank);
            if (tank) {
                Config.daily_tank_INDEX = tank.index.toString();
                !Config.load_all_mockups && this.sendMockup(Config.daily_tank_INDEX, socket);
            }
        }

        socket.talk("W", true);
    };

    disconnect(socket) {
        let check = this.clients.find(o => o.id === socket.id);
        if (check) {
            check.loops.terminate();
            util.log(`[INFO]: ${check.player.body ? check.player.body.name : "A Client"} has disconnected!`);

            util.remove(global.gameManager.views, global.gameManager.views.indexOf(socket.view));

            util.remove(this.clients, this.clients.indexOf(check));
            this.close(socket);
        }
    }
}

module.exports = { socketManager };
