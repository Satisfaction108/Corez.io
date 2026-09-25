const { workerData } = require('worker_threads');

const http = require("http");
const ws = require("ws");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

let { socketManager } = require("./game/network/sockets.js");
let { LagLogger } = require("./game/debug/lagLogger.js");
let { speedcheckloop } = require("./game/debug/speedLoop.js");
let { gameHandler } = require("./game/index.js");
let { gamemodeManager } = require("./game/gamemodeManager.js");

// /api/sendPlayer is server-to-server. It stays shut unless API_KEY is a real
// secret: with API_KEY unset, a body without a "key" used to match undefined.
function apiKeyMatches(given) {
    const expected = process.env.API_KEY;
    if (typeof expected !== "string" || expected.length < 24 || typeof given !== "string") return false;
    const a = Buffer.from(given), b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const getName = (name, gamemodeData) => {
    const nameMap = {

        clan_wars: "Clan Wars",

        ffa: "FFA",

        tdm: `${gamemodeData.teams}TDM`,
            open_tdm: `Open ${gamemodeData.teams}TDM`,
        dig_wars: "Corez.io 2TDM",
        dig_royale: "Corez.io Royale",

        train_wars: "Train Wars",

        assault_acropolis: "Assault Acropolis",
        assault_booster: "Assault Booster",
        assault_bunker: "Assault Bunker",
        assault_eye: "Assault Eye",
        assault_line: "Assault Line",
        assault_trenches: "Assault Trenches",
        assault_yinyang: "Assault Yin Yang",

        domination: `${gamemodeData.teams} Team Domination`,

        mothership: `${gamemodeData.teams} Team Mothership`,
        old_siege: "Old Siege",

        siege_blitz: "Siege Blitz",
        siege_citadel: "Siege Citadel",
        siege_classic: "Siege Classic",
        siege_fortress: "Siege Fortress",

        tag: `${gamemodeData.teams} Team Tag`,

        nexus: "Nexus",
        sandbox: "Sandbox",

        arms_race: "Arms Race",
        blackout: "Blackout",
        classic: "Classic",
        diep: "Diep",

            old_dreadnoughts: "Old Dreadnoughts",
        growth: "Growth",

        march_madness: "March Madness",
        maze: "Maze",

        outbreak: "Outbreak",

        space: "Space",

    };
    return nameMap[name];
}

class gameServer {
    constructor(host, port, gamemode, region, webProperties, serverProperties, isfeatured, parentPort, loaderGlobal) {

        Object.keys(serverProperties).forEach(key => {
            Config[key] = serverProperties[key];
        })

        this.host = host;
        this.port = port;
        this.gamemode = gamemode;
        this.region = region;
        this.webProperties = webProperties;
        this.serverProperties = serverProperties;
        this.name = "Unknown";
        this.featured = isfeatured;
        this.parentPort = parentPort;
        this.definitionsCombiner = new definitionCombiner(
            {
                groups: path.join(__dirname, './lib/definitions/groups'),
                addonsFolder: path.join(__dirname, './lib/definitions/entityAddons')
            }
        );
        this.loaderGlobal = loaderGlobal;

        this.roomSpeed = Config.game_speed;
        this.runSpeed = Config.run_speed;
        this.clients = [];
        this.views = [];
        this.minimap = [];
        this.walls = [];
        this.room = {};
        this.arenaClosed = false;
        this.importedRoom = [];
        this.importRoom = [];
        this.currentRoom = null;
        this.showConsoleLoggings = true;
        this.lagLogger = new LagLogger();
        this.socketManager = new socketManager(this);
        this.gameHandler = new gameHandler(this);
        this.gameSpeedCheckHandler = new speedcheckloop(this);

        if (!global.launchedOnMainServer) {
            console._log = console.log;
            console.log = (...args) => this.showConsoleLoggings && console._log(`[I${workerData.index}]`, ...args);
        }

        global.gameManager = this;

        this.gamemodeManager = new gamemodeManager(this);

        this.startServer();
    }

    // What the server list shows as "players". Bots are real, visible
    // inhabitants of the lobby, so they count - an empty-looking server
    // number over a genuinely lively map just keeps humans away.
    reportedPlayerCount() {
        const bots = this.gameHandler?.bots?.filter(bot => bot && !bot.isDead() && !bot.isGhost).length || 0;
        return this.socketManager.clients.length + bots;
    }

    getInfo(includegameManager = false) {
        return {
            hidden: this.serverProperties.hidden ?? false,
            ip: this.host === "localhost" ? `${this.host}:${this.port}` : this.host,
            port: this.port,
            players: this.reportedPlayerCount(),
            maxPlayers: this.webProperties.maxPlayers,
            id: this.webProperties.id,
            featured: this.featured,
            region: this.region,
            gameMode: this.name,
            gameManager: includegameManager ? this : false,
        }
    }

    startWebServer(socketManager) {

        this.wsServer = new ws.WebSocketServer({ noServer: true });

        this.httpServer = http.createServer((req, res) => {
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
            res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
            switch (req.url) {
                case "/api/sendPlayer": {
                    let body = "";
                    req.on("data", c => {
                        if (res.headersSent) return;
                        body += c;
                        if (body.length > 65536) { res.writeHead(413); res.end("Too large"); req.destroy(); }
                    });
                    req.on("end", () => {
                        if (res.headersSent) return;
                        let json = null;
                        try {
                            json = JSON.parse(body);
                    } catch { }
                        if (json) {
                            if (apiKeyMatches(json.key)) {
                                let { id, name, definition, score, level, skillcap, skill, points, killCount } = json;
                                global.travellingPlayers.push({ id, name, definition, score, level, skillcap, skill, points, killCount });
                                res.writeHead(200);
                                res.end("OK");
                            } else {
                                res.writeHead(403);
                                res.end("Access Denied");
                            }
                        } else {
                            res.writeHead(400);
                            res.end("Invalid JSON body");
                        }
                    });
                } break;
                case "/portalPermission": {
                    if (Config.allow_server_travel) {
                        res.writeHead(200);
                        res.end(JSON.stringify([{
                            ip: this.host,
                            players: this.reportedPlayerCount(),
                            gameMode: this.name,
                        }]));
                    } else {
                        res.writeHead(404);
                        res.end("Denied.");
                    }
                } break;
                case "/isOnline": {
                    res.writeHead(200);
                    res.end("True");
                } break;
                default: {

                    res.writeHead(200);
                    res.end("Not found");
                } break;
            }
        }).listen(this.port);

        this.httpServer.on("upgrade", (req, socket, head) => {
            this.wsServer.handleUpgrade(req, socket, head, ws => {
                try {
                    socketManager.connect(ws, req);
                } catch (e) {
                    console.error("[UPGRADE ERROR] " + ((e && e.stack) || e));
                    try { ws.close(); } catch (_) {}
                }
            })
        });
    }

    startServer() {

        if (!this.parentPort) {

            this.start();

            for (let i = 0; i < global.servers.length; i++) {
                let server = global.servers[i];
                if (server.loadedViaMainServer) global.servers[i] = this.getInfo(true);
            }
            // Same heartbeat as the worker path below: keep the listed player
            // number tracking bots, which join and leave without a socket.
            setInterval(() => {
                for (const server of global.servers) {
                    if (server && server.gameManager === this) server.players = this.reportedPlayerCount();
                }
            }, 5000);
            console.log(global.servers.length == 1 ? "Your game server has successfully started." : "Game server " + this.name + " successfully booted up via main server (port " + this.port + ")");
            onServerLoaded();
            return;
        };

        this.startWebServer(this.socketManager);

        this.start();

        // Accounts in a worker: its own DB connection (the main thread
        // migrated it) and the main <-> game message bus over parentPort.
        if (Config.dig_royale && !Config.tutorial) {
            try {
                const accounts = require("./accounts");
                accounts.initWorker();
                accounts.bus.setMainPoster(msg => this.parentPort.postMessage(["acct", msg]));
            } catch (e) {
                console.error("[accounts] worker init failed; guest-only here: " + ((e && e.stack) || e));
            }
        }
        this.parentPort.on("message", m => {
            if (Array.isArray(m) && m[0] === "acct") {
                try { require("./accounts").bus.toGame(m[1]); } catch (e) { /* accounts off here */ }
            }
        });

        console.log("Game server " + this.name + " successfully started. Listening on port", this.port);

        this.parentPort.postMessage([false, this.getInfo()]);

        this.parentPort.postMessage(["doneLoading"]);

        // The server list's player number is pushed, not polled, and used to
        // move only when a human connected or left. Bots spawn and die on
        // their own schedule, so heartbeat the count or the list shows 0 on
        // a lobby full of them.
        setInterval(() => {
            try { this.parentPort.postMessage([true, this.reportedPlayerCount()]); } catch (e) { /* parent gone */ }
        }, 5000);
    }

    start(softStart = false) {

        if (!softStart) {
            let overrideRoom = true;

            for (let gamemode of this.gamemode) {
                let mode = require(`./game/gamemodes/config/${gamemode}.js`);
                for (let key in mode) {
                    if (key == "do_not_override_room") {
                        overrideRoom = mode[key];
                    } else if (key == "room_setup") {
                        if (!overrideRoom) Config.room_setup = mode[key]; else Config[key].push(...mode[key]);
                    } else {
                        Config[key] = mode[key];
                    }
                }
            };

            this.name = this.gamemode.map(x => getName(x, Config) || (x[0].toUpperCase() + x.slice(1))).join(' ');

            this.showConsoleLoggings = false;

            this.definitionsCombiner.loadDefinitions(false);

            if (this.parentPort) this.loaderGlobal.loadRooms(false);

            if (Config.load_all_mockups) global.loadAllMockups(false);

            this.showConsoleLoggings = true;

            this.setRoom();

            if (Config.dig_wars || Config.dig_royale) {
                const { generate } = require('./game/terrain/mapGen.js');
                const cfg = Config.dig_royale
                    ? (Config.dig_royale_terrain || {})
                    : (Config.dig_wars_terrain || {});
                this.terrainGrid = generate({
                    cols: Config.roomWidth,
                    rows: Config.roomHeight,
                    tileWidth: Config.map_tile_width,
                    seed: cfg.seed ?? 7,
                    extrusionChance: cfg.extrusion_chance ?? 0.40,
                    // Royale keeps the FULL rectangle lattice on purpose. The
                    // old circle:true carved cells before buildVoronoi, which
                    // collapsed the lattice bounds into a thin strip. 2TDM's
                    // left/right EMPTY lanes would also leave the disk bald on
                    // east/west, so fullLattice skips those. The disk is cut
                    // later in royaleLayout by killing whole Voronoi rocks
                    // outside the circle.
                    circle: false,
                    fullLattice: !!Config.dig_royale,
                });
                // Tutorial: replace the lane map with isolated learner arenas.
                // carveTerrain sets the cell grid buildContour derives its
                // lattice bounds from, so it must land BEFORE buildContour and
                // nothing may touch the cells after it - the client recomputes
                // those same bounds from the transmitted cells. sculpt() then
                // shapes the rock by killing cells, which IS transmitted.
                const tutorialPlots = Config.tutorial
                    ? require('./game/terrain/tutorialPlots.js')
                    : null;
                if (tutorialPlots) tutorialPlots.carveTerrain(this.terrainGrid);
                this.terrainGrid.buildContour();
                if (tutorialPlots) {
                    tutorialPlots.sculpt(this.terrainGrid);
                    tutorialPlots.installSites(this.terrainGrid);
                }
            }

            setTimeout(() => {

                this.gamemodeManager.redefine(this);

                this.gamemodeManager.request("start");
            }, 200);

            if (Config.server_travel) {
                if (!Config.server_travel_properties) {
                    console.warn(this.name + " Config.server_travel_properties is not set up! Please set the properties for the server travel system to work.\nProcess terminated.");
                    process.exit(1);
                }
                this.serverTravelHandler = [];
                for (let i = 0; i < Config.server_travel.length; i++) {
                    let instance = Config.server_travel[i];
                    this.serverTravelHandler[i] = new (require("./game/addons/serverTravel.js").serverTravelHandler)(instance, instance.portal_properties.spawn_chance, instance.portal_properties.color);
                    setInterval(() => {
                        let y = 1;
                        if (Config.server_travel_properties.portals) y = Config.server_travel_properties.portals;
                        for (let o = 0; o < y; o++) this.serverTravelHandler[i].spawnRandom();
                    }, Config.server_travel_properties.loop_interval);
                }
            }
        }

        if (softStart) {

            this.arenaClosed = false;
            global.cannotRespawn = false;

            this.defineRoom();

            util.log(`New game instance is now running`);

            for (let y = 0; y < this.room.setup.length; y++) {
                for (let x = 0; x < this.room.setup[y].length; x++) {
                    let tile = this.room.setup[y][x];
                    tile.entities = [];
                    tile.init(tile, this.room, this);
                }
            };

            this.gamemodeManager.redefine(this);

            this.gamemodeManager.request("start");
        }

        this.gameHandler.run();
    }

    defineRoom() {
        this.room = {
            lastCycle: undefined,
            cycleSpeed: 1000 / this.roomSpeed / 30,
            partyHash: Number(((Math.random() * 1000000 | 0) + 1000000).toString().replace("0.", "")),
            setup: this.importedRoom,
            roomxgrid: this.importedRoom[0].length,
            roomygrid: this.importedRoom.length,
            xgrid: this.importedRoom[0].length,
            ygrid: this.importedRoom.length,
            spawnableDefault: [],
            center: {},
            spawnable: {},
            settings: {
                sandbox: {
                    do_not_change_arena_size: false
                }
            },
        };
        if (!this.wallGrid) {
            this.room.wallGrid = {
                xgrid: Config.sandbox ? 10 : 15,
                ygrid: Config.sandbox ? 10 : 15,
                width: Config.sandbox ? 600 : 900,
                height: Config.sandbox ? 600 : 900,
                getGrid: (location) => {
                    let x = Math.floor((location.x + this.room.wallGrid.width / 2) * this.room.wallGrid.xgrid / this.room.wallGrid.width);
                    let y = Math.floor((location.y + this.room.wallGrid.height / 2) * this.room.wallGrid.ygrid / this.room.wallGrid.height);
                    return {
                        x: (x + .5) / this.room.wallGrid.xgrid * this.room.wallGrid.width - this.room.wallGrid.width / 2,
                        y: (y + .5) / this.room.wallGrid.ygrid * this.room.wallGrid.height - this.room.wallGrid.height / 2,
                        id: x * this.room.wallGrid.xgrid + y
                    };
                }
            }
        }

        this.setRoomProperties();

        this.room.isInRoom = location => {
            return location.x >= -this.room.width / 2 && location.x <= this.room.width / 2 && location.y >= -this.room.height / 2 && location.y <= this.room.height / 2
        };

        this.room.near = function (position, radius) {
            let point = ran.pointInUnitCircle();
            return {
                x: Math.round(position.x + radius * point.x),
                y: Math.round(position.y + radius * point.y)
            };
        };

        this.room.random = () => {
            return {
                x: ran.irandom(this.room.width) - this.room.width / 2,
                y: ran.irandom(this.room.height) - this.room.height / 2
            };
        };

        this.room.getAt = location => {
            try {
                if (!this.room.isInRoom(location)) return null;
                let a = Math.floor((location.y + this.room.height / 2) / this.room.tileWidth);
                let b = Math.floor((location.x + this.room.width / 2) / this.room.tileHeight);
                return this.room.setup[a][b];
            } catch (e) {
                return undefined;
            }
        };

        this.room.isAt = (location) => {
            if (!this.room.isInRoom(location)) return false;
            let x = Math.floor((location.x + this.room.width / 2) * this.room.xgrid / this.room.width);
            let y = Math.floor((location.y + this.room.height / 2) * this.room.ygrid / this.room.height);
            return {
                x: (x + .5) / this.room.xgrid * this.room.width - this.room.width / 2,
                y: (y + .5) / this.room.ygrid * this.room.height - this.room.height / 2,
                id: x * this.room.xgrid + y
            };
        };
    }

    setRoomProperties() {

        Object.defineProperties(this.room, {
            tileWidth: { get: () => Config.map_tile_width, set: v => Config.map_tile_width = v },
            tileHeight: { get: () => Config.map_tile_height, set: v => Config.map_tile_height = v },
            width: { get: () => this.room.xgrid * Config.map_tile_width, set: v => Config.map_tile_width = v / this.room.xgrid },
            height: { get: () => this.room.ygrid * Config.map_tile_height, set: v => Config.map_tile_height = v / this.room.ygrid }
        });

        Object.defineProperties(this.room.center, {
            x: { get: () => this.room.xgrid * Config.map_tile_width / 2 - this.room.width / 2, set: v => Config.map_tile_width = v * 2 / this.room.xgrid - this.room.width / 2 },
            y: { get: () => this.room.ygrid * Config.map_tile_height / 2 - this.room.height / 2, set: v => Config.map_tile_height = v * 2 / this.room.ygrid - this.room.height / 2 }
        });
    }

    setRoom() {

        for (let filename of Config.room_setup) {

            this.currentRoom = require(`./game/roomSetup/rooms/${filename}.js`);
            Config.roomHeight = this.currentRoom.length;
            Config.roomWidth = this.currentRoom[0].length;

            for (let y = 0; y < Config.roomHeight; y++) {
                for (let x = 0; x < Config.roomWidth; x++) {
                    if (this.importedRoom[y] == null) {
                        this.importedRoom[y] = this.currentRoom[y];
                    } else if (this.currentRoom[y][x]) {
                        this.importedRoom[y][x] = this.currentRoom[y][x];
                    }
                }
            }
        };

        this.defineRoom();

        for (let y in this.room.setup) {
            for (let x in this.room.setup[y]) {
                let tile = this.room.setup[y][x] = new tileEntity(this.room.setup[y][x], { x, y }, this);

                tile.init(tile, this.room, this);
            }
        };
    }

    roomLoop() {

        for (let entity of entities.values()) {
            let tile = this.room.getAt(entity);
            if (tile && !entity.godmode && !entity.bond && !entity.immuneToTiles) tile.entities.push(entity);
        }

        for (let y = 0; y < this.room.setup.length; y++) {
            for (let x = 0; x < this.room.setup[y].length; x++) {
                let tile = this.room.setup[y][x];
                tile.tick(tile, this.room, this);

                tile.entities = [];
            }
        }

        if (this.room.sendColorsToClient) {
            this.room.sendColorsToClient = false;
            sockets.broadcastRoom();
        }
    }

    closeArena() {

        if (this.arenaClosed) return;

        util.saveToLog("Game Instance Ending", "Game running " + this.gamemode + " at `" + this.gamemode + "` is now closing.", 0xEE4132);
        util.log(`Arena Closing initiated`);

        this.socketManager.broadcast("Arena closed: No players may join!");
        this.arenaClosed = true;

        let spawnTimeout = setTimeout(() => {
            for (let i = 0; i < 15; i++) {

                let angle = ((Math.PI * 2) / 15) * i;

                let o = new Entity({
                    x: (this.room.width / 2 * this.room.xgrid / this.room.width) + (this.room.width / 0.7) * Math.cos(angle),
                    y: (this.room.width / 2 * this.room.xgrid / this.room.width) + (this.room.width / 0.7) * Math.sin(angle),
                });

                o.define('arenaCloser');
                o.define({
                    COLOR: "yellow",
                    SIZE: 68,
                    ACCEPTS_SCORE: false,
                    AI: {
                        FULL_VIEW: true,
                        SKYNET: true,
                        BLIND: true,
                        CHASE: true,
                    },
                    CAN_BE_ON_LEADERBOARD: false,
                    CAN_GO_OUTSIDE_ROOM: true,
                    CONTROLLERS: [["nearestDifferentMaster", { lockThroughWalls: true }], "mapTargetToGoal"],
                    SKILL: Array(10).fill(9),
                });

                o.team = TEAM_ENEMIES;
                o.name = "Arena Closer";
                o.minimapColor = "yellow";
                o.alwaysActive = true;
            }
        }, 500)

        let ticks = 0;
        let loop = setInterval(() => {
            ticks++;

            if (ticks >= 50) return clearInterval(loop), this.close(spawnTimeout);

            let alive = false;
            for (const instance of entities.values()) {
                if (
                    (instance.isPlayer && !instance.invuln && !instance.godmode) || instance.isMothership ||
                    instance.isBot ||
                    (instance.isDominator && instance.team !== TEAM_ENEMIES)
                ) {
                    alive = true;
                }
            }

            if (!alive) clearInterval(loop), this.close(spawnTimeout);
        }, 1000);
    }

    updateBounds(width, height) {

        const widthSize = parseInt(width);
        const heightSize = parseInt(height);

        this.room.width = widthSize;
        this.room.height = heightSize;

        this.socketManager.broadcastRoom();
    }

    close(spawnTimeout) {

        util.log(`Ending Game instance`);

        if (spawnTimeout) clearTimeout(spawnTimeout);

        this.socketManager.broadcast("Closing!");
        this.arenaClosed = true;
        for (let entity of entities.values()) if (entity.isPlayer || entity.isBot) entity.kill();
        setTimeout(() => {

            for (let client of this.clients) {
                client.close();
            };

            this.gamemodeManager.terminate();
            this.gameHandler.stop();

            setTimeout(() => {

                entities.clear();
                targetableEntities.clear();
                this.views = [];
                this.minimap = [];
                this.walls = [];
                this.gameHandler.bots = [];
                this.gameHandler.foods = [];
                this.gameHandler.nestFoods = [];
                global.grid.clear();
                global.spawnPoint = undefined;
                this.onEnd();
            }, 1000)
        }, 1000)
    }

    onEnd() {

        util.log(`Game instance is now over. Soft restarting the server.`);

        this.start(true);
    }

    reloadDefinitions = () => this.definitionsCombiner.loadDefinitions(false, false);
}

module.exports = { gameServer };
