let crypto = require("crypto"),
    net = require('net'),
    fs = require("fs");
    PERMABAN_FILE = "./permabans.json";
let bans = global.bans || (global.bans = []);
let permBans = global.permBans || (global.permBans = []);
global.chatID = 0;

function livingSpectateList() {
    const out = [];
    for (const e of entities.values()) {
        if (!e || e.isGhost) continue;
        if (!(e.isPlayer || e.isBot)) continue;
        if (typeof e.isDead === "function" && e.isDead()) continue;
        out.push(e);
    }
    return out;
}

function cycleSpectate(socket, dir) {
    const list = livingSpectateList();
    if (!list.length) {
        socket.spectateEntity = null;
        return;
    }
    let i = list.findIndex(e => e === socket.spectateEntity);
    if (i < 0) i = 0;
    else i = (i + (dir < 0 ? -1 : 1) + list.length) % list.length;
    socket.spectateEntity = list[i];
}

// Walk a killer (bullet/drone/tank) up to the living player or bot to follow.
function livingSpectateTarget(killers) {
    if (!Array.isArray(killers)) return livingSpectateList()[0] || null;
    for (const e of killers) {
        if (!e) continue;
        let root = e;
        for (let i = 0; i < 8 && root.master && root.master !== root; i++) root = root.master;
        if (typeof root.isDead === "function" && root.isDead()) continue;
        if (root.isPlayer || root.isBot) return root;
    }
    return livingSpectateList()[0] || null;
}

class socketManager {
    constructor(parent) {
        this.permissionsDict = {};
        this.clients = parent.clients;
        this.gamemode = parent.gamemode;
        this.players = [];
        this.disconnections = [];
        this.playersReceived = [];
        this.bans = [];

        for (let entry of require("../permissions.js")) {
            this.permissionsDict[entry.key] = entry;
        }
    };

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
                    // disconnecting = dying: kill the tank so nobody else can
                    // inherit it. (the old 60s ip-keyed "recovery" let any new
                    // connection from the same ip spawn as the previous player)
                    if (Config.clan_wars) Config.clan_wars_ft.remove(player.body);
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

        util.remove(global.gameManager.views, global.gameManager.views.indexOf(socket.view));

        // Hand the learner's plot (and its scripted bots) back to the pool.
        if (Config.tutorial) require('../tutorialSession.js').releasePlot(socket);

        util.remove(this.clients, this.clients.indexOf(socket));
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
                    if (socket.permissions) {
                        util.log(`[INFO]: A socket was verified with the token: ${key}`);
                    } else {
                        util.log(`[WARNING]: A socket failed to verify with the token: ${key}`);
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
                // A death packet and the client click can cross on the wire.
                // Accept the request when the attached body is already dead or
                // gone, instead of rejecting the first valid respawn attempt.
                const liveBody = socket.player?.body && !socket.player.body.isDead();
                if (!socket.status.deceased && liveBody) {
                    socket.kick('Trying to spawn while already alive.');
                    return 1;
                }
                socket.status.deceased = true;
                socket.status.readyToSpawn = true;
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
                if (encodeURI(name).split(/%..|./).length > 48) { socket.kick("Shorten your name!"); return 1; }
                if (typeof m[1] !== "number") { socket.kick("Bad spawn request. (needsRoom)"); return 1; }
                if (typeof autoLVLup !== "number") { socket.kick("Bad spawn request. (autoLVLup)"); return 1; }
                if (typeof incognitoMode !== "number") { socket.kick("Bad spawn request. (incognito)"); return 1; }
                if (transferbodyID && typeof transferbodyID != "string") { socket.kick("Bad body transfer. (transferbodyID)"); return 1; }
                if (transferbodyID) transferbodyID = transferbodyID.replace(name, "");

                name = name.replace(Config.banned_characters, '');

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
                        );
                    }
                    return;
                }
                let loop = setInterval(() => {

                    if (!global.cannotRespawn && !global.gameManager.arenaClosed && socket.status.readyToSpawn) {
                        if (Config.dig_royale && !require('../gamemodes/scripts/dig_royale.js').canSpawn())
                            return;
                        clearInterval(loop);
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
                if (Config.tutorial && vBody &&
                    !require('../tutorialSession.js').allows(vBody, 'bank')) return;
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
            } break;
            case "C": {

            if (m.length !== 4) {
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
                if (player.body && player.body.royaleFrozen) {
                    player.command.lmb = player.command.mmb = player.command.rmb = 0;
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
                        // While a path lock is active the client's indexes are
                        // meaningless: it clicks position N of the FILTERED
                        // menu, but upgrade() indexes the raw list - the same
                        // click could land on a hidden tank. There is exactly
                        // one legal choice under a lock, so take that one,
                        // found in the raw list, and ignore the indexes.
                        if (player.body._tutorialLock) {
                            const b = player.body;
                            const idx = b.upgrades.findIndex(u =>
                                b.skill.level >= u.level && tut.upgradeAllowed(b, u));
                            if (idx >= 0) b.upgrade(idx, 0);
                            return;
                        }
                    }
                    player.body.upgrade(upgrade, branchId);
                }
            } break;
            case "x": {

                if (m.length !== 2) {
                    socket.kick("Ill-sized skill request.");
                    return 1;
                }
                let number = m[0],
                    max = m[1],
                    stat = ["atk", "hlt", "spd", "str", "pen", "dam", "rld", "mob", "rgn", "shi"][number];

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

                // Tutorial: stat points are only spendable during the stat
                // lessons, and each of those permits exactly one bar. Gated
                // here rather than in the UI because 1-0 and M go straight to
                // the socket without ever touching the bars.
                if (Config.tutorial && player.body &&
                    !require('../tutorialSession.js').allowsStat(player.body, number)) return;

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
                    // Hand the client the landmarks of its own plot. The
                    // client cannot derive these: it knows the room, but not
                    // how the room was divided into plots.
                    case "hello": tut.talkPlotInfo(socket); break;

                    // Spawn the stationary practice target.
                    case "dummy": tut.spawnDummy(plot); break;

                    // Spawn the first opponent that shoots back (botSkill 0.1).
                    case "fighter": tut.spawnFighter(plot); break;

                    // Restrict the class-upgrade menu to a single tank, so the
                    // lesson can teach one specific build (penta shot, then a
                    // drone tank) instead of whatever the learner clicks.
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

                    // Chip the learner's health so the HP bar visibly moves and
                    // regeneration can be demonstrated. Never lethal: it clamps
                    // to a fraction of max rather than dealing damage.
                    //
                    // Takes the shield down with it. A tank at full shield and
                    // a third health barely looks damaged, and the lesson is
                    // that BOTH bars come back on their own - so both have to
                    // visibly move.
                    case "hurt":
                        if (body.health && body.health.max) {
                            body.health.amount = Math.min(
                                body.health.amount, body.health.max * 0.12);
                        }
                        if (body.shield && body.shield.max) body.shield.amount = 0;
                        break;

                    // Set the learner's stats outright, in the order the skill
                    // bar shows them. Chapters that are about flying a tank
                    // (drones, autos) hand out a working build rather than
                    // making the learner guess one first.
                    case "stats": {
                        if (typeof m[1] !== "string") return;
                        const list = m[1].split(",").map(x => parseInt(x, 10) || 0);
                        tut.setStats(body, list);
                    } break;

                    // Hand back points to spend - used when a morph unlocks a
                    // stat the learner has never seen.
                    case "points":
                        tut.grantPoints(body, parseInt(m[1], 10) || 0);
                        break;

                    // Max every stat this tank can use except one, and leave
                    // exactly that many points in hand for it: "fill,6,1".
                    case "fill":
                        tut.fillStats(body, parseInt(m[1], 10),
                                      m[2] === undefined ? 1 : parseInt(m[2], 10) || 0);
                        break;

                    // Back to full, both bars. Follows the lesson that took a
                    // deliberate bite out of them.
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
                }
            } break;
            case "EP": {
                
                
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
                if (player.body == null) return 1;
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
            }
            case "NWB": {
                socket.status.forceNewBroadcast = true;
            } break;
            case "RS": {
                if (!socket.status.deceased) return;
                cycleSpectate(socket, (m[0] | 0) < 0 ? -1 : 1);
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
            statnames = ["atk", "hlt", "spd", "str", "pen", "dam", "rld", "mob", "rgn", "shi"];

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
        // Tutorial: if the current step does not teach evolving, the menu is
        // not merely inert - it is absent. Showing clickable tanks whose
        // clicks are refused reads as a broken game, not a locked lesson.
        const tutGate = Config.tutorial ? require('../tutorialSession.js') : null;
        const tutHideMenu = tutGate && !tutGate.allows(b, 'upgrade');
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
        // outpost/vault/rock patch a lesson points at are always their own.
        // This also skips the forward-respawn logic below - a tutorial death
        // should always put you back at your own plot's start, never on a pad.
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

        // always spawn a fresh tank - a disconnected player's body is never
        // handed to a new socket (previously keyed by ip, so anyone on the
        // same network could inherit another player's tank)
        const body = new Entity(loc);
        body.protect();
        body.isPlayer = true;
        body.define(Config.spawn_class);
        // Tutorial: learners are invisible to each other, and a leaderboard
        // listing strangers' names punches a hole in that. Nobody scores here.
        if (Config.tutorial) body.settings.leaderboardable = false;
        if (Class.menu_tanks) {
            let string = Class.menu_tanks.UPGRADES_TIER_0[0];
            if (string !== "basic") {
                Class.menu_addons.UPGRADES_TIER_0.push("basic")
            }
        }
        body.name = name;
        body.incognito = socket.status.incognito ?? false;
        if (socket.permissions && socket.permissions.nameColor) {
            body.nameColor = socket.permissions.nameColor;
            socket.talk("z", body.nameColor);
        }
        body.become(player);
        socket.spectateEntity = null;
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
                body.team = team;
                body.color.base = Config.random_body_colors ?
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
        if (body.royaleLobby) body.invuln = false;
        return player;
    };

    preparePlayer(socket, player, body, doNotTakeAction = {}) {

        player.teamColor = new Color(!Config.random_body_colors && (Config.groups || (Config.mode == 'ffa' || Config.mode == 'clan' && !Config.tag)) ? 10 : global.getTeamColor(body.team)).compiled;

        player.target = { x: 0, y: 0 };

        player.command = {
            up: false,
            down: false,
            left: false,
            right: false,
            lmb: false,
            mmb: false,
            rmb: false,
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
                 // NOTE: hit feedback fields are appended AFTER alpha on purpose.
                 // perspective() rewrites this array by hardcoded index (alpha at
                 // 14 here, 18 below), so nothing may be inserted before it.
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
                     data.digWarsGoal || ""
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
                let range = 300;
                if (!other.alpha) alpha = 1;
                let dist = Math.sqrt((player.body.x - other.x) ** 2 + (player.body.y - other.y) ** 2);
                if (dist >= range) {
                    alpha = other.alpha;
                } else {
                    const rangeAlpha = 1 - (dist / range);
                    alpha = other.alpha ? other.alpha + rangeAlpha * 0.45 : rangeAlpha * 0.45;
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

                player.teamColor = new Color(!Config.random_body_colors && (Config.groups || (Config.mode == 'ffa' || Config.mode == 'clan' && !Config.tag)) ? 10 : global.getTeamColor(player.body.team)).compiled;

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
                                try { require('../gamemodes/scripts/dig_royale.js').onCombatantDead(player.body); } catch (e) { /* */ }
                            }

                            
                            
                            
                            socket.spectateEntity = livingSpectateTarget(player.body.finalKillers);

                            socket.talk("F", ...player.records());
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
                    
                    
                    let hops = 0;
                    while (socket.spectateEntity && socket.spectateEntity.isDead() && hops++ < 8) {
                        socket.spectateEntity = livingSpectateTarget(socket.spectateEntity.finalKillers);
                    }
                    if (!socket.spectateEntity || socket.spectateEntity.isDead()) {
                        cycleSpectate(socket, 1);
                    }
                    if (socket.spectateEntity) {
                        
                        
                        camera.x += (socket.spectateEntity.x - camera.x) * 0.06;
                        camera.y += (socket.spectateEntity.y - camera.y) * 0.06;
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
            ? (ent.carriedGems | 0) + (((ent.socket ? ent.socket.gemBanked : ent.botBanked) || 0) | 0)
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
            // Tutorial: every learner is on TEAM_BLUE, so the team minimap is
            // the one place they would still see each other - as friendly dots
            // scattered across arenas they cannot reach. args[1] is the
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
                if (socket.timeout.check(time)) socket.lastWords("K");
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
        socket.messageManager = socket.on("message", message => {
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

        socket.makeView = () => { socket.view = this.eyes(socket); };
        socket.makeView();

        let store = req.headers['fastly-client-ip'] || req.headers["cf-connecting-ip"] || req.headers['x-forwarded-for'] || req.headers['z-forwarded-for'] ||
                    req.headers['forwarded'] || req.headers['x-real-ip'] || req.connection.remoteAddress,
            ips = store.split(',');

        if (!ips) {
            return socket.kick("Missing IP: " + store);
        }

        for (let i = 0; i < ips.length; i++) {
            if (net.isIPv6(ips[i])) {
                ips[i] = ips[i].trim();
            } else {
                ips[i] = ips[i].split(':')[0].trim();
            }
            if (!net.isIP(ips[i])) {
                return socket.kick("Invalid IP(s): " + store);
            }
        }

        socket.ip = ips[0];

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
