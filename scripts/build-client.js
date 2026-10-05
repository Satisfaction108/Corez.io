// Builds the obfuscated client that production serves.
//
//   npm run build
//
// Every .js file under public/ is run through javascript-obfuscator and
// written to build/public/ at the same relative path, so module imports and
// the <script> tags in index.html resolve exactly as they do from source.
// Nothing else is copied; the server still serves html/css/images/sounds
// from public/ and only takes .js from here (see clientBuild in
// server/server.js). Keep editing public/client as normal, this folder is
// output only and is not committed.
//
// Two profiles. Files that run every frame (render, terrain, packet decode,
// in-raid HUD) get the light one: mangled names plus an encoded, rotated,
// shuffled string array. Control flow flattening, dead code and the rest
// cost real frame time there, so they are only used on menu/account code,
// which runs once in a while. A new file lands in the strong profile unless
// it is added to HOT below, so add anything that ends up in the frame loop.
//
// No source maps are written, on purpose. selfDefending stays off: it
// injects a regex check into random functions that runs on every call.
// OBF_DEBUG_PROTECTION=1 adds the devtools trap to the menu/account files
// only (it also costs a little CPU while devtools is open).
//
// Output goes to a temp folder and is swapped in at the end, so a failed
// build leaves the previous one untouched.

"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const acorn = require("acorn");
const JavaScriptObfuscator = require("javascript-obfuscator");

const ROOT = path.join(__dirname, "..");
const SRC = path.join(ROOT, "public");
const OUT_PARENT = path.join(ROOT, "build");
const OUT = path.join(OUT_PARENT, "public");
const MANIFEST = ".client-build.json";

// Paths relative to public/, forward slashes.
const HOT = new Set([
    "client/app.js",
    "client/canvas.js",
    "client/color.js",
    "client/config.js",
    "client/gameDraw.js",
    "client/global.js",
    "client/protocol.js",
    "client/socketinit.js",
    "client/sound.js",
    "client/terrainRenderer.js",
    "client/tutorial.js",
    "client/util.js",
    "client/coach.js",
    "client/newcomer.js",
    "client/newcomerLogic.js",
    "client/raidFinale.js",
    "client/stormFx.js",
    "client/raidHeat.js",
    "client/crowns.js",
    "client/crownArt.js",
    "client/crownsLogic.js",
    "client/raidPerks.js",
    "client/raidPerksLogic.js",
    "client/juice.js",
    "client/juiceMath.js",
    "client/hitFx.js",
    "client/skyDrop.js",
    "client/raidShare.js",
    "client/touch.js",
    "client/touchInput.js",
    "client/abilityFx.js",
    "client/halloween.js",
    "client/sidekicks.js",
    "client/sidekickArt.js",
    "client/sidekickMath.js",
    "client/achievementCard.js",
    "client/achievementsLogic.js",
    "client/account/achievements.js",
    "client/account/cosmetics.js",
    "client/account/dustHud.js",
    "client/account/gameToasts.js",
    "client/account/ingameChat.js",
    // not per frame, but the first script the menu runs (Play before the
    // client loads): keep it small, the strong profile makes files ~4x bigger
    "client/funnel.js",
]);

const base = {
    target: "browser",
    compact: true,
    simplify: true,
    identifierNamesGenerator: "mangled-shuffled",
    stringArray: true,
    stringArrayRotate: true,
    stringArrayShuffle: true,
    stringArrayIndexShift: true,
    stringArrayIndexesType: ["hexadecimal-number"],
    stringArrayThreshold: 1,
    renameProperties: false,
    selfDefending: false,
    debugProtection: false,
    disableConsoleOutput: false,
    sourceMap: false,
    unicodeEscapeSequence: false,
    advertisement: false,
    log: false,
};

const light = {
    ...base,
    stringArrayEncoding: ["base64"],
    stringArrayWrappersCount: 1,
    stringArrayWrappersType: "variable",
    stringArrayWrappersChainedCalls: false,
    stringArrayCallsTransform: false,
    controlFlowFlattening: false,
    deadCodeInjection: false,
    numbersToExpressions: false,
    splitStrings: false,
    transformObjectKeys: false,
};

const strong = {
    ...base,
    stringArrayEncoding: ["rc4"],
    stringArrayWrappersCount: 2,
    stringArrayWrappersType: "function",
    stringArrayWrappersChainedCalls: true,
    stringArrayWrappersParametersMaxCount: 4,
    stringArrayCallsTransform: true,
    stringArrayCallsTransformThreshold: 0.5,
    controlFlowFlattening: true,
    controlFlowFlatteningThreshold: 0.3,
    deadCodeInjection: true,
    deadCodeInjectionThreshold: 0.15,
    numbersToExpressions: true,
    splitStrings: true,
    splitStringsChunkLength: 8,
    transformObjectKeys: true,
    debugProtection: process.env.OBF_DEBUG_PROTECTION === "1",
    debugProtectionInterval: process.env.OBF_DEBUG_PROTECTION === "1" ? 4000 : 0,
};

function listJs(dir, rel = "") {
    const out = [];
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        if (ent.name.startsWith(".")) continue;
        const r = rel ? rel + "/" + ent.name : ent.name;
        if (ent.isDirectory()) out.push(...listJs(path.join(dir, ent.name), r));
        else if (ent.isFile() && /\.m?js$/.test(ent.name)) out.push(r);
    }
    return out.sort();
}

function parse(code, sourceType) {
    return acorn.parse(code, { ecmaVersion: "latest", sourceType, allowHashBang: true });
}

// Classic scripts share one global scope with index.html and each other, so
// their top-level names have to survive. Modules get their own scope, so
// renaming top-level names there is safe.
function isModule(code) {
    try { parse(code, "script"); return false; } catch (e) { /* not a plain script */ }
    parse(code, "module");
    return true;
}

// What other files can see: import sources and exported names. These must
// come out of the obfuscator unchanged or the module graph breaks.
function moduleShape(ast) {
    const imports = [], exports = [];
    for (const n of ast.body) {
        if (n.type === "ImportDeclaration") imports.push(n.source.value);
        else if (n.type === "ExportAllDeclaration") { imports.push(n.source.value); exports.push("*" + (n.exported ? n.exported.name || n.exported.value : "")); }
        else if (n.type === "ExportDefaultDeclaration") exports.push("default");
        else if (n.type === "ExportNamedDeclaration") {
            if (n.source) imports.push(n.source.value);
            if (n.declaration) {
                const d = n.declaration;
                if (d.id) exports.push(d.id.name);
                else if (d.declarations) for (const v of d.declarations) collectNames(v.id, exports);
            }
            for (const s of n.specifiers) exports.push(s.exported.name || s.exported.value);
        }
    }
    return JSON.stringify([imports.sort(), exports.sort()]);
}

function collectNames(pat, out) {
    if (!pat) return;
    if (pat.type === "Identifier") out.push(pat.name);
    else if (pat.type === "ObjectPattern") for (const p of pat.properties) collectNames(p.value || p.argument, out);
    else if (pat.type === "ArrayPattern") for (const p of pat.elements) collectNames(p, out);
    else if (pat.type === "RestElement") collectNames(pat.argument, out);
    else if (pat.type === "AssignmentPattern") collectNames(pat.left, out);
}

function main() {
    const t0 = Date.now();
    const files = listJs(SRC);
    const tmp = path.join(OUT_PARENT, "public.tmp-" + process.pid);
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true });

    const manifest = { builtAt: new Date().toISOString(), files: {} };
    let inBytes = 0, outBytes = 0;
    try {
        for (const rel of files) {
            const t = Date.now();
            const code = fs.readFileSync(path.join(SRC, rel), "utf8");
            const module = isModule(code);
            const profile = HOT.has(rel) ? "light" : "strong";
            const opts = { ...(profile === "light" ? light : strong), renameGlobals: module, inputFileName: rel };
            // Classic scripts share one global scope: each needs its own prefix
            // or the obfuscator's top-level helpers (string array decoders)
            // collide and the later file's overwrite the earlier one's.
            if (!module) opts.identifiersPrefix = "s" + crypto.createHash("md5").update(rel).digest("hex").slice(0, 5);
            const out = JavaScriptObfuscator.obfuscate(code, opts).getObfuscatedCode();

            const sourceType = module ? "module" : "script";
            const outAst = parse(out, sourceType);
            if (module && moduleShape(parse(code, "module")) !== moduleShape(outAst)) {
                throw new Error(rel + ": imports/exports changed during obfuscation");
            }

            const dest = path.join(tmp, rel);
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            fs.writeFileSync(dest, out);
            manifest.files[rel] = crypto.createHash("sha1").update(code).digest("hex");
            inBytes += Buffer.byteLength(code);
            outBytes += Buffer.byteLength(out);
            console.log(`  ${rel.padEnd(36)} ${profile.padEnd(6)} ${sourceType.padEnd(6)} ${kb(code)} -> ${kb(out)}  ${Date.now() - t} ms`);
        }
        fs.writeFileSync(path.join(tmp, MANIFEST), JSON.stringify(manifest, null, 1));
    } catch (e) {
        fs.rmSync(tmp, { recursive: true, force: true });
        throw e;
    }

    const old = path.join(OUT_PARENT, "public.old-" + process.pid);
    if (fs.existsSync(OUT)) fs.renameSync(OUT, old);
    fs.renameSync(tmp, OUT);
    fs.rmSync(old, { recursive: true, force: true });

    console.log(`built ${files.length} files, ${(inBytes / 1024).toFixed(0)} KB -> ${(outBytes / 1024).toFixed(0)} KB in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}

function kb(s) { return (Buffer.byteLength(s) / 1024).toFixed(1).padStart(6) + " KB"; }

main();
