"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const acorn = require("acorn");
const JsConfuser = require("js-confuser");
const JavaScriptObfuscator = require("javascript-obfuscator");

const ROOT = path.join(__dirname, "..");
const SRC = path.join(ROOT, "public");
const OUT_PARENT = path.join(ROOT, "build");
const OUT = path.join(OUT_PARENT, "public");
const MANIFEST = ".client-build.json";

const HOT = new Set([
    "client/app.js",
    "client/canvas.js",
    "client/color.js",
    "client/config.js",
    "client/gameDraw.js",
    "client/global.js",
    "client/protocol.js",
    "client/socketinit.js",
    "client/netSmooth.js",
    "client/sound.js",
    "client/terrainRenderer.js",
    "client/tutorial.js",
    "client/util.js",
    "client/coach.js",
    "client/coachLogic.js",
    "client/firstHints.js",
    "client/firstHintsLogic.js",
    "client/newcomer.js",
    "client/newcomerLogic.js",
    "client/firstSeconds.js",
    "client/firstSecondsLogic.js",
    "client/raidFinale.js",
    "client/mineDust.js",
    "client/stormFx.js",
    "client/raidHeat.js",
    "client/teamWar.js",
    "client/teamWarLogic.js",
    "client/crowns.js",
    "client/crownArt.js",
    "client/crownsLogic.js",
    "client/scoreLogic.js",
    "client/bankPopLogic.js",
    "client/raidPerks.js",
    "client/upgradeGridLogic.js",
    "client/tankTree.js",
    "client/tankTreeLogic.js",
    "client/raidPerksLogic.js",
    "client/juice.js",
    "client/juiceMath.js",
    "client/hitFx.js",
    "client/gunKick.js",
    "client/skyDrop.js",
    "client/raidShare.js",
    "client/chatPanelLogic.js",
    "client/keepNudge.js",
    "client/touch.js",
    "client/touchInput.js",
    "client/abilityFx.js",
    "client/halloween.js",
    "client/homeWorld.js",
    "client/deathCardLogic.js",
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
    "client/autoQuality.js",
    "client/autoQualityLogic.js",
    "client/labelLayout.js",
    "client/netSmooth.js",
    "client/predict.js",
    "client/signupPrompt.js",
    "client/signupPromptLogic.js",
    "client/alwaysOn.js",
    "client/tankRecords.js",
    "client/eventFx.js",
    "client/abilityDrops.js",
    "client/funnel.js",
]);

let seed = 1;
Math.random = () => {
    seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
};
const hashInt = (str) => parseInt(crypto.createHash("md5").update(str).digest("hex").slice(0, 8), 16);

const notPath = (s) => typeof s !== "string" || !/^\.{0,2}\//.test(s);
const some = (p) => (s) => notPath(s) && Math.random() < p;

const light = {
    target: "browser",
    compact: true,
    hexadecimalNumbers: true,
    renameVariables: true,
    renameLabels: true,
    identifierGenerator: "randomized",
};

const lightStrings = {
    target: "browser",
    compact: true,
    simplify: true,
    identifierNamesGenerator: "mangled-shuffled",
    renameGlobals: false,
    stringArray: true,
    stringArrayRotate: true,
    stringArrayShuffle: true,
    stringArrayIndexShift: true,
    stringArrayIndexesType: ["hexadecimal-number"],
    stringArrayThreshold: 1,
    stringArrayEncoding: ["base64"],
    stringArrayWrappersCount: 1,
    stringArrayWrappersType: "variable",
    selfDefending: false,
    debugProtection: false,
    sourceMap: false,
    log: false,
};

const strong = {
    ...light,
    stringConcealing: notPath,
    astScrambler: true,
    dispatcher: 0.5,
    opaquePredicates: 0.5,
    calculator: true,
    stringSplitting: some(0.25),
    globalConcealing: true,
    duplicateLiteralsRemoval: some(0.5),
};

function listFiles(dir, re, rel = "") {
    const out = [];
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        if (ent.name.startsWith(".")) continue;
        const r = rel ? rel + "/" + ent.name : ent.name;
        if (ent.isDirectory()) out.push(...listFiles(path.join(dir, ent.name), re, r));
        else if (ent.isFile() && re.test(ent.name)) out.push(r);
    }
    return out.sort();
}

function parse(code, sourceType) {
    return acorn.parse(code, { ecmaVersion: "latest", sourceType, allowHashBang: true });
}

function isModule(code) {
    try { parse(code, "script"); return false; } catch (e) { }
    parse(code, "module");
    return true;
}

function topNames(ast) {
    const out = [];
    for (const n of ast.body) {
        if ((n.type === "FunctionDeclaration" || n.type === "ClassDeclaration") && n.id) out.push(n.id.name);
        else if (n.type === "VariableDeclaration") for (const d of n.declarations) collectNames(d.id, out);
    }
    return out;
}

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

function quoteExports(code) {
    const ast = parse(code, "module");
    const decl = new Map();
    for (const n of ast.body) {
        if ((n.type === "FunctionDeclaration" || n.type === "ClassDeclaration") && n.id) decl.set(n.id.name, n);
        else if (n.type === "VariableDeclaration" && n.declarations.length === 1 && n.declarations[0].id.type === "Identifier") decl.set(n.declarations[0].id.name, n);
    }
    const names = new Set(), edits = [];
    for (const n of ast.body) {
        if (n.type !== "ExportNamedDeclaration" || n.declaration || !n.specifiers.length) continue;
        const specs = [];
        for (const sp of n.specifiers) {
            const local = sp.local.name || sp.local.value, exported = sp.exported.name || sp.exported.value;
            const d = !n.source && local === exported && decl.get(local);
            if (d) { edits.push({ at: d.start, end: d.start, text: "export " }); decl.delete(local); continue; }
            names.add(exported);
            if (n.source) names.add(local);
            specs.push((n.source ? JSON.stringify(local) : local) + " as " + JSON.stringify(exported));
        }
        edits.push({ at: n.start, end: n.end, text: specs.length ? "export { " + specs.join(", ") + " }" + (n.source ? " from " + JSON.stringify(n.source.value) : "") + ";" : "" });
    }
    edits.sort((a, b) => b.at - a.at || b.end - a.end);
    for (const e of edits) code = code.slice(0, e.at) + e.text + code.slice(e.end);
    return { code, names };
}

function unquoteExports(code) {
    const ast = parse(code, "module");
    const edits = [];
    const id = (x) => x.type === "Literal" ? x.value : x.name;
    for (const n of ast.body) {
        if (n.type !== "ExportNamedDeclaration" || n.declaration || !n.specifiers.some(sp => sp.local.type === "Literal" || sp.exported.type === "Literal")) continue;
        const specs = n.specifiers.map(sp => id(sp.local) === id(sp.exported) ? id(sp.local) : id(sp.local) + " as " + id(sp.exported));
        edits.push({ at: n.start, end: n.end, text: "export{" + specs.join(",") + "}" + (n.source ? "from" + JSON.stringify(n.source.value) : "") + ";" });
    }
    for (const e of edits.reverse()) code = code.slice(0, e.at) + e.text + code.slice(e.end);
    return code;
}

function guardStrings(opts, names) {
    const o = { ...opts };
    for (const k of ["stringConcealing", "stringEncoding", "stringSplitting", "duplicateLiteralsRemoval"]) {
        const f = o[k];
        if (typeof f === "function") o[k] = (v) => !(typeof v === "string" && names.has(v)) && f(v);
    }
    return o;
}

async function obfuscate(code, profile, name, ownScope) {
    const module = isModule(code);
    let input = code, names = new Set(), renameGlobals = true;
    if (module) ({ code: input, names } = quoteExports(code));
    if (!module) {
        if (!ownScope && topNames(parse(code, "script")).length) renameGlobals = false;
        else input = "(function(){" + code + "\n}).call(this);";
    }
    const opts = guardStrings({ ...(profile === "light" ? light : strong), renameGlobals }, names);
    const want = module ? moduleShape(parse(code, "module")) : null;
    const globals = !module && !renameGlobals ? topNames(parse(code, "script")) : [];
    let lastErr = null;
    for (let attempt = 0; attempt < 6; attempt++) {
        try {
            seed = hashInt(name + "\0" + attempt + "\0" + code);
            let out = (await JsConfuser.obfuscate(input, opts)).code;
            if (profile === "light") {
                const jo = { ...lightStrings, inputFileName: name, seed: hashInt("jo\0" + name + "\0" + code) };
                if (!module) jo.identifiersPrefix = "s" + crypto.createHash("md5").update(name).digest("hex").slice(0, 5);
                if (names.size) jo.reservedStrings = [...names].map(n => "^" + n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$");
                out = JavaScriptObfuscator.obfuscate(module ? unquoteExports(out) : out, jo).getObfuscatedCode();
            }
            const outAst = parse(out, module ? "module" : "script");
            if (module && moduleShape(outAst) !== want) throw new Error("imports/exports changed during obfuscation");
            const have = new Set(topNames(outAst));
            for (const n of globals) if (!have.has(n)) throw new Error("global " + n + " was renamed");
            if (attempt) console.log(`  ${name}: ok on try ${attempt + 1}`);
            return { out, module };
        } catch (e) {
            lastErr = e;
        }
    }
    throw new Error(name + ": " + lastErr.message);
}

const stripCss = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").map(l => l.trim()).filter(Boolean).join("\n");

async function cleanHtml(html, rel) {
    const parts = [];
    const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
    let last = 0, m, n = 0;
    while ((m = re.exec(html))) {
        parts.push(html.slice(last, m.index));
        last = re.lastIndex;
        const attrs = m[1], code = m[2];
        if (/\bsrc\s*=/i.test(attrs) || !code.trim()) { parts.push("<script" + attrs + "></script>"); continue; }
        const type = (attrs.match(/\btype\s*=\s*["']?([^"'\s>]+)/i) || [])[1] || "";
        if (/json/i.test(type)) {
            try { parts.push("<script" + attrs + ">" + JSON.stringify(JSON.parse(code)) + "</script>"); } catch (e) { parts.push(m[0]); }
            continue;
        }
        const { out } = await obfuscate(code, "strong", rel + "#" + (n++));
        parts.push("<script" + attrs + ">" + out + "</script>");
    }
    parts.push(html.slice(last));
    html = parts.join("");
    html = html.replace(/<style\b([^>]*)>([\s\S]*?)<\/style>/gi, (all, attrs, css) => "<style" + attrs + ">" + stripCss(css) + "</style>");
    html = html.replace(/<!--[\s\S]*?-->/g, "");
    if (/<(pre|textarea)\b/i.test(html)) return html;
    return html.split("\n").map(l => l.trim()).filter(Boolean).join("\n");
}

async function main() {
    const t0 = Date.now();
    const files = listFiles(SRC, /\.m?js$/);
    const moduleSrcs = new Set();
    for (const rel of listFiles(SRC, /\.html$/)) {
        const html = fs.readFileSync(path.join(SRC, rel), "utf8");
        for (const m of html.matchAll(/<script\b[^>]*>/gi)) {
            const src = (m[0].match(/\bsrc\s*=\s*["']([^"']+)["']/i) || [])[1];
            if (src && /\btype\s*=\s*["']?module/i.test(m[0])) moduleSrcs.add(src.replace(/^\//, "").split("?")[0]);
        }
    }
    const tmp = path.join(OUT_PARENT, "public.tmp-" + process.pid);
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true });

    const manifest = { builtAt: new Date().toISOString(), files: {} };
    let inBytes = 0, outBytes = 0;
    const put = (rel, src, out) => {
        const dest = path.join(tmp, rel);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, out);
        manifest.files[rel] = crypto.createHash("sha1").update(src).digest("hex");
        inBytes += Buffer.byteLength(src);
        outBytes += Buffer.byteLength(out);
    };
    try {
        for (const rel of files) {
            const t = Date.now();
            const code = fs.readFileSync(path.join(SRC, rel), "utf8");
            const profile = HOT.has(rel) ? "light" : "strong";
            const { out, module } = await obfuscate(code, profile, rel, moduleSrcs.has(rel));
            put(rel, code, out);
            console.log(`  ${rel.padEnd(36)} ${profile.padEnd(6)} ${(module ? "module" : "script").padEnd(6)} ${kb(code)} -> ${kb(out)}  ${Date.now() - t} ms`);
        }
        for (const rel of listFiles(SRC, /\.(html|css)$/)) {
            const src = fs.readFileSync(path.join(SRC, rel), "utf8");
            put(rel, src, rel.endsWith(".css") ? stripCss(src) : await cleanHtml(src, rel));
        }
        const SHARED_SRC = path.join(ROOT, "shared");
        for (const name of fs.readdirSync(SHARED_SRC).filter(n => /\.js$/.test(n)).sort()) {
            const code = fs.readFileSync(path.join(SHARED_SRC, name), "utf8");
            const { out } = await obfuscate(code, "light", "shared/" + name);
            put("_shared/" + name, code, out);
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

main().catch(e => { console.error(e.message || e); process.exit(1); });
