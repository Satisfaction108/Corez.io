// Which client the server is handing out right now, as a short opaque string.
// Open tabs poll it (/api/version) and reload once it moves, so a deploy
// reaches players without a hard refresh (public/client/version.js).
//
// With the obfuscated build it follows the build: builtAt and the file hashes
// from build/public/.client-build.json, re-read when that file changes, so a
// rebuild shows up without a restart. The build is swapped in with one rename,
// so a poll never sees half of it. Without a build (dev) it is a hash of every
// file's size and mtime under public/, so saving a client file bumps it.
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const MANIFEST = ".client-build.json";
const SCAN_MS = 2000;

const short = (s) => crypto.createHash("sha1").update(s).digest("hex").slice(0, 12);

function scanTree(dir) {
    const parts = [];
    const walk = (d, rel) => {
        let ents;
        try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
        for (const ent of ents) {
            if (ent.name.startsWith(".")) continue;
            const r = rel ? rel + "/" + ent.name : ent.name;
            if (ent.isDirectory()) walk(path.join(d, ent.name), r);
            else if (ent.isFile()) {
                try {
                    const st = fs.statSync(path.join(d, ent.name));
                    parts.push(r + ":" + st.size + ":" + Math.floor(st.mtimeMs));
                } catch (e) { /* gone mid-scan */ }
            }
        }
    };
    walk(dir, "");
    return parts.sort().join("|");
}

// buildDir: the build/public folder when serving the build, else null
function clientVersion({ publicDir, buildDir = null }) {
    let value = "", checkedAt = 0, manifestStamp = "";

    function fromBuild() {
        const file = path.join(buildDir, MANIFEST);
        let st;
        try { st = fs.statSync(file); } catch (e) { return value || "nobuild"; }
        const stamp = st.size + ":" + st.mtimeMs;
        if (stamp === manifestStamp && value) return value;
        try {
            const m = JSON.parse(fs.readFileSync(file, "utf8"));
            value = "b" + short(String(m.builtAt) + JSON.stringify(m.files || {}));
            manifestStamp = stamp;
        } catch (e) { /* mid-write; keep the last good one */ }
        return value || "nobuild";
    }

    return function get() {
        const now = Date.now();
        if (value && now - checkedAt < SCAN_MS) return value;
        checkedAt = now;
        value = buildDir ? fromBuild() : "d" + short(scanTree(publicDir));
        return value;
    };
}

// The menu page with the version it was served at, so the tab knows what it
// is running before its first poll.
function stampHtml(html, version) {
    const tag = `<meta name="client-version" content="${version}">`;
    const i = html.indexOf("</head>");
    return i < 0 ? tag + html : html.slice(0, i) + tag + "\n" + html.slice(i);
}

module.exports = { clientVersion, stampHtml };
