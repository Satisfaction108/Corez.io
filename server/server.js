// Log startup messages
console.log("Starting up...");
console.log("Importing modules...\n");

const path = require("path");
const fs = require("fs");
const http = require("http");
const net = require("net");
const url = require("url");
const crypto = require("crypto");
const pjson = require('../package.json')
const { clientIp } = require("./lib/clientIp.js");

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

    // Set each environment variable in process.env; a variable already set
    // (pm2, the shell, a test run) wins over the file, as with dotenv
    for (const key in environment) {
        if (process.env[key] === undefined) process.env[key] = environment[key];
    }
} catch (e) {
    if (e.code !== "ENOENT") console.error("[ENV LOAD ERROR] " + ((e && e.stack) || e));
}

// Accounts (sessions, Discord login, SQLite). Guest-only if unavailable.
const accounts = require("./accounts");
try { accounts.initMain(); } catch (e) {
    console.error("[accounts] init failed; running guest-only: " + ((e && e.stack) || e));
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
    txt: "text/plain; charset=utf-8",
    ico: "image/x-icon",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
    gif: "image/gif",
    ttf: "font/ttf",
    woff: "font/woff",
    woff2: "font/woff2",
    wav: "audio/wav",
    mp3: "audio/mpeg",
    ogg: "audio/ogg",
    mp4: "video/mp4",
};

// Map a request path onto a real file inside public/. Returns the absolute
// path; null when it names nothing servable (the caller falls back to the
// menu page); undefined when the path itself is malformed (400).
// Traversal ("/../server/.env", "/%2e%2e/...", "/..%2f...") is clamped by
// normalising against "/" first, then re-checked against the resolved root,
// and dotfiles (.env, .DS_Store, .git) are never served.
const publicRootAbs = path.resolve(publicRoot);
let publicRootReal = publicRootAbs;
try { publicRootReal = fs.realpathSync(publicRootAbs); } catch (e) { /* keep the resolved path */ }
const insideDir = (dir, file) => file === dir || file.startsWith(dir + path.sep);
function publicFile(pathname) {
    let rel;
    try {
        rel = decodeURIComponent(pathname);
    } catch (e) {
        return undefined;
    }
    if (rel.includes("\0")) return undefined;
    // Backslash is a separator on Windows; treat it as one everywhere.
    const normal = path.posix.normalize("/" + rel.replace(/\\/g, "/"));
    if (normal.split("/").some((seg) => seg.startsWith("."))) return null;
    const file = path.resolve(publicRootAbs, "." + normal);
    if (!insideDir(publicRootAbs, file)) return null;
    try {
        // lstat: symlinks are not served (same as before this check existed).
        if (!fs.lstatSync(file).isFile()) return null;
        if (!insideDir(publicRootReal, fs.realpathSync(file))) return null;
    } catch (e) {
        return null;
    }
    return file;
}

function sendStatic(res, file) {
    const extension = file.split(".").pop();
    // No heuristic caching: a client must never run a stale app.js
    // against a freshly restarted server.
    res.writeHead(200, { "Content-Type": mimeSet[extension] || "text/html", "Cache-Control": "no-cache" });
    fs.createReadStream(file).on("error", () => res.destroy()).pipe(res);
}

// /api/sendPlayer is server-to-server. It stays shut unless API_KEY is a real
// secret: with API_KEY unset, a body without a "key" used to match undefined.
function apiKeyMatches(given) {
    const expected = process.env.API_KEY;
    if (typeof expected !== "string" || expected.length < 24 || typeof given !== "string") return false;
    const a = Buffer.from(given), b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

let wsServer; // WebSocket server instance
let server; // HTTP server instance

// Tutorial / Dig Wars workers live on loopback ports. The public host only
// exposes the main port, so the homepage talks to these paths and we splice
// the websocket through.
const TUTORIAL_PROXY_PATH = "/tut";
const DIG_WARS_PROXY_PATH = "/dw";

function listedServer(id) {
    const live = (global.servers || []).find((s) => s && s.id === id);
    const cfg = (Config.servers || []).find((s) => s && s.id === id);
    if (!live && !cfg) return null;
    return {
        ip: (live && live.ip) || (cfg && cfg.host) || Config.host,
        port: (live && live.port) || (cfg && cfg.port),
        players: (live && live.players) | 0,
        maxPlayers: (live && live.maxPlayers) || (cfg && cfg.player_cap) || 0,
        id,
        featured: !!(live && live.featured),
        region: (live && live.region) || (cfg && cfg.region) || "",
        gameMode: (live && live.gameMode) || "",
        hidden: !!(cfg && cfg.unlisted) || !!(live && live.hidden),
    };
}

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
    try {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    // /api/*, /auth/*, /discord/* belong to accounts (before the CORS block,
    // so account responses never carry Access-Control-Allow-Origin)
    if (accounts.handleHttp(req, res)) return;
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
    for (let server of (global.servers || [])) {
        if (!server || !server.ip || server.ip === Config.host) continue;
        let http = String(server.ip).startsWith("localhost") ? `http://${server.ip}` : `https://${server.ip}`;
        serversIP.push(http);
    }
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
            readString = JSON.stringify((global.servers || []).filter((s) => s && s.id && !s.hidden).map((server) => ({
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
            const tut = listedServer("tut");
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
            const dw = listedServer("dw");
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
            for (const s of (global.servers || [])) {
                if (s && s.players) countPlayers += s.players;
            }
            readString = JSON.stringify(countPlayers);
        } break;
        case "/version": {
            readString = JSON.stringify({ver: 'v' + pjson.version, devBuild: Config.devBuild});
        } break;
        
        case "/api/getAddonAuthors": {
            // no token: empty list instead of a 403 the client logs on every load
            readString = (!query.token || query.token !== process.env.DEVELOPER) ? "[]" : JSON.stringify(global.addonAuthorInfos);
        } break;

        case "/api/sendPlayer": {
            ok = false;
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
            let fileToGet = publicFile(pathname);
            if (fileToGet === undefined) {
                res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
                res.end("Bad request");
                break;
            }

            // If the requested file doesn't exist or isn't a file, default to the INDEX_HTML file
            if (!fileToGet) fileToGet = path.join(publicRoot, `${selectedHeader}/index.html`);

            sendStatic(res, fileToGet);
        } break;

        default: {
            // For all other routes, serve static files from the public directory
            ok = false;
            let fileToGet = publicFile(pathname);
            if (fileToGet === undefined) {
                res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
                res.end("Bad request");
                break;
            }

            // If the requested file doesn't exist, isn't a file, or lies
            // outside public/, default to the main_menu file
            if (!fileToGet) fileToGet = path.join(publicRoot, Config.main_menu);

            sendStatic(res, fileToGet);
        } break;
    }

    // If an API endpoint was handled, send the JSON response
    if (ok) {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(readString);
    }
    } catch (e) {
        console.error("[HTTP ERROR] " + ((e && e.stack) || e));
        try {
            if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
            res.end("null");
        } catch (_) { /* already closed */ }
    }
});

// Loads a game server
// main -> game account messages (kicks) reach games running in workers too
global.gameWorkers = new Map();
accounts.bus.setWorkerPoster(msg => {
    for (const w of global.gameWorkers.values()) {
        try { w.postMessage(["acct", msg]); } catch (e) { /* worker gone */ }
    }
});

function loadGameServer(loadViaMain = false, host, port, gamemode, region, webProperties, properties, isFeatured, isUnlisted = false) {
    const id = webProperties && webProperties.id;
    // Two games cannot share one process. A second share_client_server used
    // to process.exit(1) and take the whole site down (tutorial included).
    if (loadViaMain && (global.launchedOnMainServer || global._mainLoadScheduled)) {
        console.warn("Already loading a main-process game; " + id + " will run as a worker.");
        loadViaMain = false;
    }

    if (!loadViaMain) {
        let index = global.servers.length;
        global.servers.push({ id, hidden: !!isUnlisted, port, ip: host });

        let worker = new Worker("./server/serverLoader.js", {
            workerData: {
                host,
                port: port,
                gamemode,
                region,
                webProperties,
                properties,
                isFeatured,
                index,
            }
        });

        worker.on("error", (err) => {
            console.error("[WORKER ERROR] " + id + ": " + ((err && err.stack) || err));
        });
        worker.on("exit", (code) => {
            if (code !== 0) console.error("[WORKER EXIT] " + id + " code " + code);
        });

        global.gameWorkers.set(id, worker);
        worker.on("message", message => {
            const flag = message.shift();
            switch (flag) {
                case "acct":
                    accounts.bus.fromGame(id, message.shift());
                    break;
                case false:
                    global.servers[index] = message.shift();
                    global.servers[index].hidden = !!isUnlisted;
                    break;
                case true:
                    if (global.servers[index]) global.servers[index].players = message.shift();
                    break;
                case "doneLoading":
                    onServerLoaded();
                    break;
            }
        });
    } else {
        global._mainLoadScheduled = true;
        global.servers.push({ loadedViaMainServer: true, id });
        setTimeout(() => {
            if (global.launchedOnMainServer) {
                console.warn("Main-process game already running; not starting " + id + " on the web port.");
                return;
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
function workerPort(id) {
    const s = (Config.servers || []).find((server) => server && server.id === id);
    return s ? s.port : null;
}

function tutorialPort() {
    return workerPort("tut");
}

const FORWARDING_HEADERS = new Set([
    "x-forwarded-for", "forwarded", "x-real-ip", "cf-connecting-ip", "fastly-client-ip", "z-forwarded-for",
]);

function proxyUpgradeToWorker(req, socket, head, proxyPath, port) {
    if (!port) return socket.destroy();

    const upstream = net.connect(port, "127.0.0.1", () => {
        const path = req.url.slice(proxyPath.length) || "/";
        let raw = `GET ${path} HTTP/1.1\r\n`;
        for (let i = 0; i < req.rawHeaders.length; i += 2) {
            // Forwarding headers from outside are dropped; the worker trusts
            // loopback, so the one X-Forwarded-For it gets must be ours.
            if (FORWARDING_HEADERS.has(String(req.rawHeaders[i]).toLowerCase())) continue;
            raw += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
        }
        const ip = clientIp(req);
        if (ip) raw += `X-Forwarded-For: ${ip}\r\n`;
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
        if (!workerPort("dw")) { try { socket.destroy(); } catch (e) { /* */ } return; }
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

// pm2 restarts send SIGINT: close the database cleanly (WAL checkpoint).
let shuttingDown = false;
for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => {
        if (shuttingDown) return;
        shuttingDown = true;
        try { accounts.shutdown(); } catch (e) { console.error("[accounts] shutdown failed: " + ((e && e.stack) || e)); }
        process.exit(0);
    });
}
