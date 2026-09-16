// Log startup messages
console.log("Starting up...");
console.log("Importing modules...\n");

const path = require("path");
const fs = require("fs");
const http = require("http");
const net = require("net");
const url = require("url");
const pjson = require('../package.json')

const { Worker } = require("worker_threads");

// Increase the stack trace limit for better debugging
Error.stackTraceLimit = Infinity;

// Render safety net: one bad packet or a game bug must not take the whole
// demo down. Log it and keep serving; if it's genuinely melting down (many
// crashes in a row), exit so Render recycles the process cleanly.
let crashCount = 0;
process.on("uncaughtException", (err) => {
    console.error("[UNCAUGHT EXCEPTION] " + ((err && err.stack) || err));
    if (crashCount++ > 20) process.exit(1);
    setTimeout(() => crashCount--, 30_000);
});
process.on("unhandledRejection", (reason) => {
    console.error("[UNHANDLED REJECTION] " + ((reason && reason.stack) || reason));
    if (crashCount++ > 20) process.exit(1);
    setTimeout(() => crashCount--, 30_000);
});

// Load environment variables from .env when present (local dev only).
// Secrets are NOT committed to git - in production they come from the
// platform's env vars (Render dashboard) instead, so a missing .env is fine.
const dotenv = require("./lib/dotenv.js");
try {
    const envContent = fs.readFileSync(path.join(__dirname, "./.env")).toString();
    const environment = dotenv(envContent);

    // Set each environment variable in process.env
    for (const key in environment) {
        process.env[key] = environment[key];
    }
} catch (e) {
    if (e.code !== "ENOENT") console.error("[ENV LOAD ERROR] " + ((e && e.stack) || e));
}

// Load all necessary modules and files via the loader
const GLOBAL = require("./loaders/loader.js");

// Load definitions and tile definitions
new definitionCombiner(
    {
        groups: path.join(__dirname, './lib/definitions/groups'),
        addonsFolder: path.join(__dirname, './lib/definitions/entityAddons')
    }
).loadDefinitions();
GLOBAL.loadRooms(true);

// Optionally load all mockups if enabled in configuration
if (Config.load_all_mockups) global.loadAllMockups();

// Log loader information including creation date and time
console.log(`Successfully loaded all files.`);
console.log(`Created on date ${GLOBAL.creationDate} at timestamp ${GLOBAL.creationTime}`);

// Define the public directory for static files
const publicRoot = path.join(__dirname, "../public/"),
mimeSet = {
    js: "application/javascript",
    json: "application/json",
    css: "text/css",
    html: "text/html",
    md: "text/markdown",
    png: "image/png",
    svg: "image/svg+xml",
};

let wsServer; // WebSocket server instance
let server; // HTTP server instance

// Attempt to create a WebSocket server instance using the 'ws' package
try {
    const WebSocketServer = require("ws").WebSocketServer;
    wsServer = new WebSocketServer({ noServer: true });
} catch (err) {
    throw new Error(
        "Package 'ws' is not installed! To install it, run 'npm install ws' in the terminal."
    );
}

// Log a warning if Access-Control-Allow-Origin is enabled
if (Config.allow_ACAO && Config.startup_logs) {
    util.warn("Access-Control-Allow-Origin is enabled, which allows any server/client to access data from the WebServer.");
}

// Create an HTTP server to handle both API and static file requests
server = http.createServer((req, res) => {
    let query = {};
    let pathname = req.url.split("?")[0];
    if (req.url.includes("?")) req.url.split("?")[1].split("&").map(i => {
        let key = i.split("=")[0];
        let value = i.split("=")[1];
        query[key] = value;
    });
    let readString = ""; // Response content for API endpoints
    let ok = true; // Flag to indicate whether we use default API response
    let serversIP = [];
    let clientHeaders = ["/ext/custom-shape"];
    let selectedHeader = null;

    // Set CORS headers if enabled in the configuration or allow only the children servers.
    for (let server of global.servers) if (server.ip !== Config.host && server.ip) {
        let http = server.ip.startsWith("localhost") ? `http://${server.ip}` : `https://${server.ip}`;
        serversIP.push(http);
    };
    if (Config.allow_ACAO || serversIP.includes(req.headers.origin)) {
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    }
    for (let i = 0; i < clientHeaders.length; i++) {
        if (clientHeaders[i] == req.url) {
            selectedHeader = clientHeaders[i];
        }
    }
    // Handle specific API endpoints based on the request URL
    switch (pathname) {
        case "/getServers.json": {
            // Serve a list of active servers (excluding hidden ones)
            readString = JSON.stringify(servers.filter((s) => s && !s.hidden).map((server) => ({
                ip: server.ip,
                players: server.players,
                maxPlayers: server.maxPlayers,
                id: server.id,
                featured: server.featured,
                region: server.region,
                gameMode: server.gameMode,
            })));
        } break;
        // The tutorial server is deliberately absent from /getServers.json so it
        // never shows up on the region picker. The homepage Tutorial button
        // asks for it here instead, by id.
        case "/getTutorialServer.json": {
            const tut = servers.find((s) => s && s.id === "tut");
            readString = JSON.stringify(tut ? {
                ip: tut.ip,
                port: tut.port,
                players: tut.players,
                maxPlayers: tut.maxPlayers,
                id: tut.id,
                // Reach the tutorial through THIS host on THIS port: the
                // container routes only one port to the domain, so the
                // tutorial worker's own port is not reachable from outside.
                mainHost: Config.host,
                proxyPath: TUTORIAL_PROXY_PATH,
            } : null);
        } break;
        case "/getDigWarsServer.json": {
            const dw = servers.find((s) => s && s.id === "dw");
            readString = JSON.stringify(dw ? {
                ip: dw.ip,
                port: dw.port,
                players: dw.players,
                maxPlayers: dw.maxPlayers,
                id: dw.id,
                mainHost: Config.host,
                proxyPath: DIG_WARS_PROXY_PATH,
            } : null);
        } break;
        case "/getTotalPlayers": {
            let countPlayers = 0;
            servers.forEach((s) => {
                countPlayers += s.players;
            });
            readString = JSON.stringify(countPlayers);
        } break;
        case "/version": {
            readString = JSON.stringify({ver: 'v' + pjson.version, devBuild: Config.devBuild});
        } break;
        
        case "/api/getAddonAuthors": {
            if (!query.token || query.token !== process.env.DEVELOPER) {
                res.writeHead(403);
                res.end("Forbidden");
                return;
            }
            readString = JSON.stringify(global.addonAuthorInfos);
        } break;

        case "/api/sendPlayer": {
            ok = false;
            let body = "";
            req.on("data", c => body += c);
            req.on("end", () => {
                let json = null;
                try {
                    json = JSON.parse(body);
              } catch { }
                  if (json) {
                      if (json.key === process.env.API_KEY) {
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
            ok = false;
            let sserver = [];
            if (Config.allow_server_travel && global.launchedOnMainServer) {
                for (let i = 0; i < global.servers.length; i++) {
                    let server = global.servers[i];
                    if (server.gameManager) sserver.push(server);
                }
                res.writeHead(200);
                res.end(JSON.stringify(sserver.map((server) => ({
                    ip: server.ip,
                    players: server.players,
                    gameMode: server.gameMode,
                }))));
            } else {
                res.writeHead(404);
                res.end("Denied.");
            }
        } break;
        case "/isOnline": {
            readString = "true";
        } break;
        case selectedHeader: {
            // For all other routes, serve static files from the public directory
            ok = false;
            let fileToGet = path.join(publicRoot, req.url);

            // If the requested file doesn't exist or isn't a file, default to the INDEX_HTML file
            if (!fs.existsSync(fileToGet) || !fs.lstatSync(fileToGet).isFile()) {
                fileToGet = path.join(publicRoot, `${selectedHeader}/index.html`);
            }

            // Determine the file's MIME type based on its extension and serve the file stream
            const extension = fileToGet.split(".").pop();
            res.writeHead(200, { "Content-Type": mimeSet[extension] || "text/html" });
            fs.createReadStream(fileToGet).pipe(res);
        } break;

        default: {
            // For all other routes, serve static files from the public directory
            ok = false;
            let fileToGet = path.join(publicRoot, pathname);

            // If the requested file doesn't exist or isn't a file, default to the main_menu file
            if (!fs.existsSync(fileToGet) || !fs.lstatSync(fileToGet).isFile()) {
                fileToGet = path.join(publicRoot, Config.main_menu);
            }

            // Determine the file's MIME type based on its extension and serve the file stream
            const extension = fileToGet.split(".").pop();
            res.writeHead(200, { "Content-Type": mimeSet[extension] || "text/html" });
            fs.createReadStream(fileToGet).pipe(res);
        } break;
    }

    // If an API endpoint was handled, send the JSON response
    if (ok) {
        res.writeHead(200);
        res.end(readString);
    }
});

// Loads a game server
function loadGameServer(loadViaMain = false, host, port, gamemode, region, webProperties, properties, isFeatured, isUnlisted = false) {
    // Determine the new server index and initialize an empty object in the global servers array
    if (!loadViaMain) {
        let index = global.servers.length;
        global.servers.push({});

        // Create a new worker thread to load the game server asynchronously
        let worker = new Worker("./server/serverLoader.js", {
            workerData: {
                host,
                port: port, // Increment port for each server
                gamemode,
                region,
                webProperties,
                properties,
                isFeatured,
                index,
            }
        });

        // Listen for messages from the worker to update the server's status
        worker.on("message", message => {
            const flag = message.shift();
            switch (flag) {
                case false:
                    // Initial load: store server details
                    global.servers[index] = message.shift();
                    // Unlisted servers (the tutorial) stay out of
                    // /getServers.json, so the region picker never shows them.
                    // They remain reachable directly by their id.
                    global.servers[index].hidden = !!isUnlisted;
                    break;
                case true:
                    // Update: change the server's player count
                    global.servers[index].players = message.shift();
                    break;
                case "doneLoading":
                    // Once loading is complete, trigger the server loaded callback
                    onServerLoaded();
                    break;
            }
        });
    } else {
        global.servers.push({ loadedViaMainServer: true });
        setTimeout(() => { // Space it a little out.
            if (global.launchedOnMainServer) {
                console.warn("Only one server can be loaded via through the main server!\nProcess terminated.");
                process.exit(1);
            }
            global.launchedOnMainServer = true;
            new (require("./game.js").gameServer)(Config.host, Config.port, gamemode, region, webProperties, properties, isFeatured, false);
        }, 10)
    }
}

// Server Loaded Callback
let loadedServers = 0;
global.onServerLoaded = () => {
    loadedServers++;
    // Once all servers are loaded, log the status and routing table
    if (loadedServers >= global.servers.length) {
        util.saveToLog("Servers up", "All servers booted up.", 0x37F554);
        if (Config.startup_logs) {
            util.log("Dumping endpoint -> gamemode routing table");
            for (const game of global.servers) {
                console.log("> " + `${Config.host}/#${game.id}`.padEnd(40, " ") + " -> " + game.gameMode);
            }
            console.log("\n");
        }
        let serverStartEndTime = performance.now();
        console.log("Server loaded in " + util.rounder(serverStartEndTime, 4) + " milliseconds.");
        console.log("[WEB SERVER]: Server listening on port", Config.port);
    }
};

// Automatically resolve the server's region from the box's public ip so the
// server-list always reflects where it actually lives. Prefers a
// SERVER_REGION override, then a quick geo lookup, then Europe (nest default).
async function detectRegion() {
    if (process.env.SERVER_REGION) return process.env.SERVER_REGION;
    const byContinent = { EU: "Europe", NA: "USA", AS: "Asia", OC: "Oceania" };
    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 4000);
        const res = await fetch("https://ipapi.co/json/", {
            signal: controller.signal,
            headers: { "User-Agent": "digwars/1.0 (+https://digwars.hackclub.app)" },
        });
        clearTimeout(timer);
        const data = await res.json();
        const cc = String(data.continent_code || "").toUpperCase();
        if (byContinent[cc]) return byContinent[cc];
        return data.country_code === "US" ? "USA" : "Europe";
    } catch (e) {
        return "Europe";
    }
}

// start the http server & load game servers
server.listen(Config.port, () => {
    detectRegion().then(region => {
        Config.servers.forEach(server => {
            server.region = region; // real location always wins, no manual edits
            // Load all of the servers.
            loadGameServer(
                server.share_client_server,
                server.host,
                server.port,
                server.gamemode,
                server.region,
                { id: server.id, maxPlayers: server.player_cap },
                server.properties,
                server.featured,
                server.unlisted
            );
        })
    })
});

// Upgrade HTTP connections to WebSocket connections if applicable
// Tutorial WebSocket proxy.
//
// Two game servers cannot share one process (Config and global.gameManager are
// process-wide), so the tutorial runs as its own worker on its own port. But
// the container routes exactly one port to the domain, so that worker is
// unreachable from outside. The fix is to forward the upgrade ourselves: a
// socket arriving at <main host>/tut is spliced straight through to the
// tutorial worker on loopback. No extra domain, no extra open port.
const TUTORIAL_PROXY_PATH = "/tut";
const DIG_WARS_PROXY_PATH = "/dw";

function workerPort(id) {
    const s = (Config.servers || []).find((server) => server && server.id === id);
    return s ? s.port : null;
}

function tutorialPort() {
    return workerPort("tut");
}

function proxyUpgradeToWorker(req, socket, head, proxyPath, port) {
    if (!port) return socket.destroy();

    const upstream = net.connect(port, "127.0.0.1", () => {
        const path = req.url.slice(proxyPath.length) || "/";
        let raw = `GET ${path} HTTP/1.1\r\n`;
        for (let i = 0; i < req.rawHeaders.length; i += 2) {
            raw += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
        }
        upstream.write(raw + "\r\n");
        if (head && head.length) upstream.write(head);
        upstream.pipe(socket);
        socket.pipe(upstream);
    });

    const bail = () => { try { upstream.destroy(); } catch (e) { } try { socket.destroy(); } catch (e) { } };
    upstream.on("error", bail);
    socket.on("error", bail);
}

function proxyUpgradeToTutorial(req, socket, head) {
    return proxyUpgradeToWorker(req, socket, head, TUTORIAL_PROXY_PATH, tutorialPort());
}

server.on("upgrade", (req, socket, head) => {
    const url = req.url || "";
    if (url === TUTORIAL_PROXY_PATH || url.startsWith(TUTORIAL_PROXY_PATH + "/") ||
        url.startsWith(TUTORIAL_PROXY_PATH + "?")) {
        return proxyUpgradeToTutorial(req, socket, head);
    }
    if (url === DIG_WARS_PROXY_PATH || url.startsWith(DIG_WARS_PROXY_PATH + "/") ||
        url.startsWith(DIG_WARS_PROXY_PATH + "?")) {
        return proxyUpgradeToWorker(req, socket, head, DIG_WARS_PROXY_PATH, workerPort("dw"));
    }
    wsServer.handleUpgrade(req, socket, head, (ws) => {
        try {
            if (global.launchedOnMainServer) {
                for (let i = 0; i < global.servers.length; i++) {
                    let server = global.servers[i];
                    if (server.gameManager) server.gameManager.socketManager.connect(ws, req);
                }
            } else {
                ws.close();
            }
        } catch (e) {
            console.error("[UPGRADE ERROR] " + ((e && e.stack) || e));
            try { ws.close(); } catch (_) {}
        }
    });
});

// Set up a loop to periodically call Bun's garbage collector if available
let bunLoop = setInterval(() => {
    try {
        Bun.gc(true);
    } catch (e) {
        // If Bun.gc fails, clear the interval
        clearInterval(bunLoop);
    }
}, 1000);

// Log that the web server has been initialized if logging is enabled
if (Config.startup_logs) console.log("Web Server initialized.");
