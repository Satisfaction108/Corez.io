// Log startup messages
console.log("Starting up...");
console.log("Importing modules...\n");

const path = require("path");
const fs = require("fs");
const http = require("http");
const net = require("net");
const url = require("url");
const crypto = require("crypto");
const zlib = require("zlib");
const pjson = require('../package.json')
const { clientIp } = require("./lib/clientIp.js");
const { clientVersion, stampHtml } = require("./lib/clientVersion.js");

const { Worker } = require("worker_threads");

// Increase the stack trace limit for better debugging
Error.stackTraceLimit = Infinity;

// Crash safety net: one bad packet or game bug must not take the site down.
// Log and keep serving; after many crashes in a row, exit so the process
// manager restarts it cleanly.
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

// Load .env when present (local dev). Secrets are not committed; in production
// they come from the environment, so a missing .env is fine.
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
    webmanifest: "application/manifest+json",
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
// path; null when it names nothing servable (caller falls back to the menu
// page); undefined when the path is malformed (400). Traversal is clamped by
// normalising against "/" and re-checking against the resolved root; dotfiles
// (.env, .DS_Store, .git) are never served.
const insideDir = (dir, file) => file === dir || file.startsWith(dir + path.sep);
function rootOf(dir) {
    const abs = path.resolve(dir);
    let real = abs;
    try { real = fs.realpathSync(abs); } catch (e) { /* keep the resolved path */ }
    return { abs, real };
}
const publicRootDir = rootOf(publicRoot);
const publicRootAbs = publicRootDir.abs;

// Production serves client JS from build/public (npm run build, see
// scripts/build-client.js); html/css/images still come from public/.
// CLIENT_BUILD=obfuscated|source forces a mode, otherwise NODE_ENV=production
// picks the build. In build mode nothing script-like (.js, .jssave, .map...)
// is ever read from public/, so stray readable copies stay private.
const buildRoot = path.join(__dirname, "../build/public");
// (.json is data, not script: preview-mockups.json and friends stay in public/)
const SCRIPT_LIKE = /\.(m?js(?!on$)\w*|map)$/i;
const clientBuild = (() => {
    const want = process.env.CLIENT_BUILD || (process.env.NODE_ENV === "production" ? "obfuscated" : "source");
    if (want !== "obfuscated") return null;
    let manifest;
    try {
        manifest = JSON.parse(fs.readFileSync(path.join(buildRoot, ".client-build.json"), "utf8"));
    } catch (e) {
        console.error("[client] no obfuscated build in build/public (run `npm run build`); serving readable source");
        return null;
    }
    // Warn when the build is behind the source, e.g. a pull without a rebuild.
    const stale = [];
    const walk = (dir, rel) => {
        for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
            if (ent.name.startsWith(".")) continue;
            const r = rel ? rel + "/" + ent.name : ent.name;
            if (ent.isDirectory()) walk(path.join(dir, ent.name), r);
            else if (/\.m?js$/.test(ent.name)) {
                const sha = crypto.createHash("sha1").update(fs.readFileSync(path.join(dir, ent.name))).digest("hex");
                if (manifest.files[r] !== sha) stale.push(r);
            }
        }
    };
    try { walk(publicRootAbs, ""); } catch (e) { /* only a warning */ }
    if (stale.length) console.error(`[client] obfuscated build is out of date for ${stale.length} file(s) (${stale.slice(0, 5).join(", ")}); run \`npm run build\``);
    console.log(`[client] serving obfuscated client built ${manifest.builtAt}`);
    return rootOf(buildRoot);
})();
const currentClient = clientVersion({ publicDir: publicRootAbs, buildDir: clientBuild ? buildRoot : null });
const menuPage = path.resolve(publicRoot, Config.main_menu);

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
    const root = clientBuild && SCRIPT_LIKE.test(normal) ? clientBuild : publicRootDir;
    const file = path.resolve(root.abs, "." + normal);
    if (!insideDir(root.abs, file)) return null;
    try {
        // lstat: symlinks are not served.
        if (!fs.lstatSync(file).isFile()) return null;
        if (!insideDir(root.real, fs.realpathSync(file))) return null;
    } catch (e) {
        return null;
    }
    return file;
}

// Game portals (iogames.space, itch.io, Newgrounds...) show the game in an
// iframe on their own site, so the game's pages may be framed by anyone.
// That is safe because the session cookie is SameSite=Lax: a cross-site frame
// never gets it, so the framed game is always a guest and the account screens
// send people to a real tab (client/account/main.js). The account API and
// the reset page stay unframeable (the defaults set in the request handler).
function allowFraming(res) {
    res.removeHeader("X-Frame-Options");
    res.setHeader("Content-Security-Policy", "frame-ancestors *");
}

// Text files are compressed once (gzip and brotli, on the zlib threadpool, so
// the game loop on this thread never waits on it) and kept in memory until the
// file changes. Every static response carries an ETag, so a reload costs a 304.
// Caddy passes a response that is already encoded straight through.
const COMPRESSIBLE = new Set(["js", "json", "webmanifest", "css", "html", "md", "svg", "txt", "ico"]);
const MEDIA = new Set(["png", "jpg", "jpeg", "webp", "gif", "ttf", "woff", "woff2", "wav", "mp3", "ogg", "mp4"]);
// TrueType shrinks to about 40% with brotli (Rubik 360 KB -> 122 KB), and the
// menu waits on it, so fonts are compressed too but keep their hour of cache
const FONTS = new Set(["ttf", "otf"]);
const staticCache = new Map();   // file -> { key, ready: Promise of { etag, raw, gz, br } }
const STATIC_CACHE_MAX_BYTES = 64 * 1024 * 1024;
let staticCacheBytes = 0;

function compressedEntry(file, key, body) {
    const hit = staticCache.get(file);
    if (hit && hit.key === key) return hit.ready;
    const ready = Promise.all([
        new Promise((ok) => zlib.gzip(body, { level: 9 }, (e, out) => ok(e ? null : out))),
        new Promise((ok) => zlib.brotliCompress(body, { params: {
            [zlib.constants.BROTLI_PARAM_QUALITY]: 9,
            [zlib.constants.BROTLI_PARAM_SIZE_HINT]: body.length,
        } }, (e, out) => ok(e ? null : out))),
    ]).then(([gz, br]) => {
        const entry = { raw: body, gz, br, etag: '"' + crypto.createHash("sha1").update(body).digest("base64url").slice(0, 20) + '"' };
        const bytes = body.length + (gz ? gz.length : 0) + (br ? br.length : 0);
        if (staticCacheBytes + bytes > STATIC_CACHE_MAX_BYTES) { staticCache.clear(); staticCacheBytes = 0; }
        staticCacheBytes += bytes;
        staticCache.set(file, { key, ready: Promise.resolve(entry) });
        return entry;
    });
    staticCache.set(file, { key, ready });
    return ready;
}

function notModified(req, etag) {
    const inm = req && req.headers["if-none-match"];
    return !!inm && inm.split(",").some((t) => t.trim().replace(/^W\//, "") === etag);
}

function sendEntry(req, res, type, entry, cacheControl) {
    const headers = { "Content-Type": type, "Cache-Control": cacheControl, "ETag": entry.etag, "Vary": "Accept-Encoding" };
    if (notModified(req, entry.etag)) { res.writeHead(304, headers); res.end(); return; }
    const accept = String((req && req.headers["accept-encoding"]) || "");
    let body = entry.raw;
    if (entry.br && /\bbr\b/.test(accept) && entry.br.length < body.length) { body = entry.br; headers["Content-Encoding"] = "br"; }
    else if (entry.gz && /\bgzip\b/.test(accept) && entry.gz.length < body.length) { body = entry.gz; headers["Content-Encoding"] = "gzip"; }
    headers["Content-Length"] = body.length;
    res.writeHead(200, headers);
    res.end(req && req.method === "HEAD" ? undefined : body);
}

function sendStatic(res, file, req) {
    const extension = file.split(".").pop().toLowerCase();
    if (extension === "html") allowFraming(res);
    const type = mimeSet[extension] || "text/html";
    const fail = () => { if (!res.headersSent) { res.writeHead(500); } res.end(); };
    fs.stat(file, (err, st) => {
        if (err || !st.isFile()) return fail();
        const key = st.size + ":" + st.mtimeMs;
        // No heuristic caching: a client must never run a stale app.js against a
        // freshly restarted server, so scripts, styles and pages revalidate
        // (a cheap 304). Pictures, sounds and fonts may sit for an hour.
        if (path.resolve(file) === menuPage) {
            const version = currentClient();
            return fs.readFile(file, "utf8", (err, html) => {
                if (err) return fail();
                compressedEntry(file, key + ":" + version, Buffer.from(stampHtml(html, version)))
                    .then((entry) => sendEntry(req, res, "text/html", entry, "no-cache"), fail);
            });
        }
        if ((COMPRESSIBLE.has(extension) || FONTS.has(extension)) && st.size <= 8 * 1024 * 1024) {
            const cc = FONTS.has(extension) ? "public, max-age=3600" : "no-cache";
            const hit = staticCache.get(file);
            if (hit && hit.key === key) return hit.ready.then((entry) => sendEntry(req, res, type, entry, cc), fail);
            return fs.readFile(file, (err, body) => {
                if (err) return fail();
                compressedEntry(file, key, body).then((entry) => sendEntry(req, res, type, entry, cc), fail);
            });
        }
        const etag = '"' + st.size.toString(36) + "-" + Math.floor(st.mtimeMs).toString(36) + '"';
        const headers = { "Content-Type": type, "Cache-Control": MEDIA.has(extension) ? "public, max-age=3600" : "no-cache", "ETag": etag };
        if (notModified(req, etag)) { res.writeHead(304, headers); res.end(); return; }
        headers["Content-Length"] = st.size;
        res.writeHead(200, headers);
        if (req && req.method === "HEAD") return res.end();
        fs.createReadStream(file).on("error", () => res.destroy()).pipe(res);
    });
}

// /api/sendPlayer is server-to-server. It stays shut unless API_KEY is a real
// secret (24+ chars), so an unset key can never match a missing one.
function apiKeyMatches(given) {
    const expected = process.env.API_KEY;
    if (typeof expected !== "string" || expected.length < 24 || typeof given !== "string") return false;
    const a = Buffer.from(given), b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

let wsServer; // WebSocket server instance
let server; // HTTP server instance

// Tutorial / Dig Wars workers live on loopback ports. The public host only
// exposes the main port, so the homepage talks to these paths and the
// websocket is spliced through.
const TUTORIAL_PROXY_PATH = "/tut";
const DIG_WARS_PROXY_PATH = "/dw";
// The duo raid server (a worker, like the tutorial): the menu's DUOS mode
// dials <this host>/duo and the websocket is spliced through to its port.
const DUO_PROXY_PATH = "/duo";

// The host a page reached us on, when it is the old domain (MOVE_FROM_HOST):
// its raid sockets dial the same host so its cookie goes along. Anything
// else gets Config.host as before.
function gameHostFor(req) {
    const host = String(req.headers.host || "").toLowerCase();
    return accounts.config.isMoveHost(host) ? host : Config.host;
}

function serverCfg(id) {
    return (Config.servers || []).find((s) => s && s.id === id) || null;
}

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
    wsServer = new WebSocketServer({
        noServer: true,
        // Snapshots shrink about in half; matters most on slow, far links.
        // Level 1 + no context takeover keeps CPU and memory per socket low.
        perMessageDeflate: {
            zlibDeflateOptions: { level: 1, memLevel: 7 },
            threshold: 512,
            serverNoContextTakeover: true,
            clientNoContextTakeover: true,
            concurrencyLimit: 8,
        },
    });
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
    // Nothing may be framed by default. Only the game's own pages (sendStatic)
    // lift this, so portals can embed them; /api, /auth and /discord keep it.
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Content-Security-Policy", "frame-ancestors 'none'");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    // open tabs poll this to notice a deploy (public/client/version.js)
    if (req.url.split("?")[0] === "/api/version" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        res.end(JSON.stringify({ v: currentClient() }));
        return;
    }
    // a page load on the old domain gets the moving page (accounts/routes/move.js)
    if (accounts.move.servePage(req, res)) return;
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
            // the overflow solo raids are unlisted; their counts go on the solo row
            const overflow = (global.servers || []).filter((s) => s && s.clientsAt && (serverCfg(s.id) || {}).soloOverflow);
            const ownHost = gameHostFor(req);
            readString = JSON.stringify((global.servers || []).filter((s) => s && s.id && !s.hidden).map((server) => {
                const cfg = serverCfg(server.id);
                const duo = server.mode === "duo" || !!(cfg && cfg.properties && cfg.properties.royale_duos);
                const extra = !duo && server.gameManager ? overflow : [];
                return {
                    ip: duo || server.ip === Config.host ? ownHost : server.ip,
                    players: extra.reduce((n, s) => n + (s.players | 0), server.players | 0),
                    maxPlayers: extra.reduce((n, s) => n + (s.maxPlayers | 0), server.maxPlayers | 0),
                    id: server.id,
                    featured: server.featured,
                    region: server.region || (cfg && cfg.region) || "",
                    gameMode: server.gameMode,
                    // raid servers say which menu mode they are; the duo one is
                    // reached through this host at proxyPath, never its own port
                    mode: duo ? "duo" : (server.mode || undefined),
                    proxyPath: duo ? DUO_PROXY_PATH : undefined,
                };
            }));
        } break;
        // The tutorial server is absent from /getServers.json so it never shows on
        // the region picker; the homepage Tutorial button asks for it here by id.
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
                mainHost: gameHostFor(req),
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
                mainHost: gameHostFor(req),
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
        // the how-to-play page portals link to (public/about.html)
        case "/about":
        case "/how-to-play": {
            ok = false;
            sendStatic(res, path.join(publicRoot, "about.html"), req);
        } break;
        case "/devlog":
        case "/devlog/": {
            ok = false;
            sendStatic(res, path.join(publicRoot, "devlog.html"), req);
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

            sendStatic(res, fileToGet, req);
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

            sendStatic(res, fileToGet, req);
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
    // Two games cannot share one process: a second share_client_server game
    // runs as a worker instead.
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
                case "clients":
                    if (global.servers[index]) {
                        global.servers[index].clients = message.shift() | 0;
                        global.servers[index].clientsAt = Date.now();
                    }
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

// Resolve the server's region from the box's public ip: SERVER_REGION
// override, then a quick geo lookup (US boxes get East/Central/West from
// longitude), then Europe.
async function detectRegion() {
    if (process.env.SERVER_REGION) return process.env.SERVER_REGION;
    const byContinent = { EU: "Europe", NA: "USA", AS: "Asia", OC: "Oceania" };
    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 4000);
        const res = await fetch("https://ipapi.co/json/", {
            signal: controller.signal,
            headers: { "User-Agent": "corez/1.0 (+https://corez.io)" },
        });
        clearTimeout(timer);
        const data = await res.json();
        const cc = String(data.continent_code || "").toUpperCase();
        // US boxes get a coast: east of -95 longitude is East, west of -110 West
        if (data.country_code === "US" || data.country_code === "CA") {
            const lon = Number(data.longitude);
            if (isFinite(lon)) return lon > -95 ? "US East" : lon < -110 ? "US West" : "US Central";
            return "USA";
        }
        if (byContinent[cc]) return byContinent[cc];
        return "Europe";
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

// Which solo raid a new websocket joins. The main-thread raid fills first, then
// the overflow workers in order (config.js SOLO_RAIDS). A raid takes new players
// up to SOLO_SOFT_CAP; past that, whichever has fewest, up to its player_cap
// (the hard limit sockets.js enforces at spawn). Connections sent in the last
// moments count too, so a burst doesn't all land on the same raid before its
// next count. A reconnect from the same address goes back to its raid, which is
// where its resume token lives. Returns the raid, null for "this thread", or
// false when all are full.
const SOLO_SOFT_CAP = parseInt(process.env.SOLO_SOFT_CAP) || 16;
const SOLO_STICKY_MS = 3 * 60 * 1000;
const soloSent = new Map();     // raid id -> times a socket was sent there
const soloSticky = new Map();   // client ip -> { id, at }
function soloRaids() {
    const out = [];
    const now = Date.now();
    const main = (global.servers || []).find((s) => s && s.gameManager);
    if (!main || main.mode !== "solo") return out;
    // this thread's count is live; only a handshake still in flight is missing
    out.push({ id: main.id, port: null, clients: main.gameManager.socketManager.clients.length,
        cap: main.maxPlayers || 0, since: now - 150 });
    for (const cfg of Config.servers || []) {
        if (!cfg || !cfg.soloOverflow) continue;
        const live = (global.servers || []).find((s) => s && s.id === cfg.id);
        // a worker that stopped reporting is skipped (still booting, or gone)
        if (!live || !live.clientsAt || now - live.clientsAt > 5000) continue;
        out.push({ id: cfg.id, port: cfg.port, clients: live.clients | 0, cap: cfg.player_cap || 0, since: live.clientsAt - 150 });
    }
    return out;
}
function pickSoloRaid(req) {
    const raids = soloRaids();
    if (raids.length < 2 && !(raids[0] && raids[0].cap)) return null;
    const now = Date.now();
    const load = (r) => {
        const sent = (soloSent.get(r.id) || []).filter((t) => t > r.since && t > now - 5000);
        soloSent.set(r.id, sent);
        return r.clients + sent.length;
    };
    const room = (r, cap) => !r.cap || load(r) < Math.min(cap, r.cap);
    const ip = clientIp(req) || "";
    const stuck = ip && soloSticky.get(ip);
    let pick = null;
    if (stuck && now - stuck.at < SOLO_STICKY_MS) pick = raids.find((r) => r.id === stuck.id && room(r, Infinity)) || null;
    // during a live event (Raid Night) fill each raid to its hard cap first,
    // so everyone who shows up plays together instead of spreading out at 16
    let soft = SOLO_SOFT_CAP;
    try { const ev = require("../shared/events.js").current(now); if (ev && ev.live) soft = Infinity; } catch { /* no events file */ }
    if (!pick) pick = raids.find((r) => room(r, soft)) || null;
    if (!pick) {
        for (const r of raids) if (room(r, Infinity) && (!pick || load(r) < load(pick))) pick = r;
    }
    if (!pick) return false;
    soloSent.get(pick.id).push(now);
    if (ip) {
        soloSticky.set(ip, { id: pick.id, at: now });
        if (soloSticky.size > 5000) {
            for (const [k, v] of soloSticky) if (now - v.at > SOLO_STICKY_MS) soloSticky.delete(k);
        }
    }
    return pick;
}

server.on("upgrade", (req, socket, head) => {
    const url = req.url || "";
    if (url === TUTORIAL_PROXY_PATH || url.startsWith(TUTORIAL_PROXY_PATH + "/") ||
        url.startsWith(TUTORIAL_PROXY_PATH + "?")) {
        return proxyUpgradeToTutorial(req, socket, head);
    }
    if (url === DUO_PROXY_PATH || url.startsWith(DUO_PROXY_PATH + "/") ||
        url.startsWith(DUO_PROXY_PATH + "?")) {
        if (!workerPort("duo")) { try { socket.destroy(); } catch (e) { /* */ } return; }
        return proxyUpgradeToWorker(req, socket, head, DUO_PROXY_PATH, workerPort("duo"));
    }
    if (url === DIG_WARS_PROXY_PATH || url.startsWith(DIG_WARS_PROXY_PATH + "/") ||
        url.startsWith(DIG_WARS_PROXY_PATH + "?")) {
        if (!workerPort("dw")) { try { socket.destroy(); } catch (e) { /* */ } return; }
        return proxyUpgradeToWorker(req, socket, head, DIG_WARS_PROXY_PATH, workerPort("dw"));
    }
    // Solo: the raid on this thread, or an overflow raid with more room
    const raid = pickSoloRaid(req);
    if (raid && raid.port) return proxyUpgradeToWorker(req, socket, head, "", raid.port);
    wsServer.handleUpgrade(req, socket, head, (ws) => {
        try {
            if (raid === false) {
                // every raid is full: 4001 sends the client back to the menu
                // with this line instead of retrying
                ws.close(4001, "All raids are full right now. Try again in a minute!");
                return;
            }
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
        // a game in a worker thread settles its open ranked lives on its own
        // connection; give it a moment before the process goes
        const workers = global.gameWorkers ? global.gameWorkers.size : 0;
        if (workers) { try { accounts.bus.toGame({ t: "shutdown" }); } catch (e) { /* */ } }
        try { accounts.shutdown(); } catch (e) { console.error("[accounts] shutdown failed: " + ((e && e.stack) || e)); }
        if (workers) setTimeout(() => process.exit(0), 300);
        else process.exit(0);
    });
}
