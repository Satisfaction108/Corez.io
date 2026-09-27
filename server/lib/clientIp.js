// Client IP resolution behind a reverse proxy.
//
// X-Forwarded-For is only honoured when the TCP peer is in TRUSTED_PROXIES
// (comma list of IPs or CIDRs, default "127.0.0.1,::1"). Loopback is always
// trusted: the main process proxies worker sockets over loopback and sets
// X-Forwarded-For itself (server.js proxyUpgradeToWorker).
// The header is walked right-to-left past trusted hops, so client-written
// entries (further left) never win. Other forwarding headers are ignored.
const net = require("net");

const DEFAULT_TRUSTED = "127.0.0.1,::1";
const ALWAYS_TRUSTED = [["127.0.0.0", 8, "ipv4"], ["::1", 128, "ipv6"]];

let cachedSpec = null;
let cachedList = null;
// Untrusted peers already reported as sending X-Forwarded-For. Capped so a
// spoofing client cannot flood the log.
const reportedPeers = new Set();
const MAX_REPORTED_PEERS = 5;

// "::ffff:1.2.3.4" -> "1.2.3.4", "[::1]:80" -> "::1", "1.2.3.4:80" -> "1.2.3.4".
function normalize(addr) {
    let a = String(addr == null ? "" : addr).trim();
    if (a.startsWith("[")) {
        const end = a.indexOf("]");
        if (end > 0) a = a.slice(1, end);
    }
    if (/^::ffff:/i.test(a) && net.isIPv4(a.slice(7))) a = a.slice(7);
    if (!net.isIP(a)) {
        const withPort = /^(\d{1,3}(?:\.\d{1,3}){3}):\d{1,5}$/.exec(a);
        if (withPort) a = withPort[1];
    }
    return a;
}

function ipType(addr) {
    return net.isIPv4(addr) ? "ipv4" : net.isIPv6(addr) ? "ipv6" : null;
}

// Rebuilt only when the env value changes (.env is loaded after some modules).
function trustedList() {
    const raw = process.env.TRUSTED_PROXIES;
    const spec = raw == null || !String(raw).trim() ? DEFAULT_TRUSTED : String(raw);
    if (spec === cachedSpec) return cachedList;
    const list = new net.BlockList();
    for (const [addr, bits, type] of ALWAYS_TRUSTED) list.addSubnet(addr, bits, type);
    for (const item of spec.split(",").map((s) => s.trim()).filter(Boolean)) {
        const slash = item.indexOf("/");
        const addr = normalize(slash < 0 ? item : item.slice(0, slash));
        const type = ipType(addr);
        const bits = slash < 0 ? null : Number(item.slice(slash + 1));
        const maxBits = type === "ipv4" ? 32 : 128;
        if (!type || (bits !== null && !(Number.isInteger(bits) && bits >= 0 && bits <= maxBits))) {
            console.warn(`[clientIp] ignoring bad TRUSTED_PROXIES entry "${item}"`);
            continue;
        }
        if (bits === null) list.addAddress(addr, type);
        else list.addSubnet(addr, bits, type);
    }
    cachedSpec = spec;
    cachedList = list;
    return list;
}

function isTrustedProxy(addr) {
    const a = normalize(addr);
    const type = ipType(a);
    if (!type) return false;
    try {
        return trustedList().check(a, type);
    } catch (e) {
        return false;
    }
}

// Logs an untrusted proxy's address so the operator can add it to TRUSTED_PROXIES.
function reportProxiedPeer(peer) {
    if (reportedPeers.has(peer) || reportedPeers.size >= MAX_REPORTED_PEERS) return;
    reportedPeers.add(peer);
    console.warn(`[clientIp] a proxied request (X-Forwarded-For) came from ${peer}, which is not trusted` +
        ` - add it to TRUSTED_PROXIES if that is your reverse proxy`);
}

function clientIp(req) {
    const peer = normalize(req && req.socket && req.socket.remoteAddress);
    const xff = req && req.headers && req.headers["x-forwarded-for"];
    if (!xff || !peer) return peer;
    if (!isTrustedProxy(peer)) {
        reportProxiedPeer(peer);
        return peer;
    }
    const hops = String(Array.isArray(xff) ? xff.join(",") : xff).split(",").map(normalize).filter(Boolean);
    for (let i = hops.length - 1; i >= 0; i--) {
        // a trusted proxy never writes garbage, so this hop was forged
        if (!ipType(hops[i])) return peer;
        if (!isTrustedProxy(hops[i])) return hops[i];
    }
    // every hop is trusted (a local client through a local proxy)
    return hops.length ? hops[0] : peer;
}

module.exports = { clientIp, isTrustedProxy };
