// Picks up a deploy in tabs that were already open. The server stamps the
// menu page with the client version it served (<meta name="client-version">)
// and answers /api/version with the current one; this checks it every minute
// while the tab is visible and on every socket open (socketinit.js), since a
// deploy restarts the server and drops every game socket anyway.
//
// A newer version reloads the page, but never in the middle of a life:
//   menu            right away, unless an account pane or form is up or
//                   the player is typing
//   dead            once the death card has had its full wait (it holds
//                   the drop from the start, then reloads straight away)
//   raid over       once the podium and the reward tally are done
//   tutorial        never, it reloads the page itself when it ends
// In a life it only shows a card: "Update ready, refreshing after this life".
//
// Loop guard: the version we reload for goes in sessionStorage, and the same
// version never triggers a second reload within a minute.
import { global } from "./global.js";
import * as raidFinale from "./raidFinale.js";
import * as gameToasts from "./account/gameToasts.js";
import * as ui from "./account/ui.js";
import * as welcome from "./account/welcome.js";
import * as rankCeremony from "./account/rankCeremony.js";

const CHECK_MS = 60000;
const SOCKET_CHECK_GAP_MS = 5000;
const SETTLE_MS = 2500;       // a safe moment has to hold this long in game
const DEAD_SETTLE_MS = 400;   // dead: the card already had its time
const TYPING_MS = 5000;       // menu: no reload this soon after a key press
const LOOP_MS = 60000;
const GUARD_KEY = "dwReloadFor";
const REJOIN_KEY = "dwRejoinAfterUpdate";
const UPDATE_POLL_MS = 1500;
const UPDATE_WAIT_MS = 180000;

const meta = document.querySelector('meta[name="client-version"]');
let running = meta ? meta.getAttribute("content") || "" : "";
let pending = "";
let checkedAt = 0, inFlight = null;
let safeSince = 0, noteShown = "", lastKeyAt = 0;
let tick = 0;
let hiddenAt = 0, openedAt = 0;
const FRESH_MS = 30000;       // an update found this soon after joining reloads at once
const PLAY_WAIT_MS = 1500;    // Play waits at most this long for a version answer

function guard() {
    try { return JSON.parse(sessionStorage.getItem(GUARD_KEY) || "null"); } catch (e) { return null; }
}
function reloadedRecently(v) {
    const g = guard();
    return !!(g && g.v === v && Date.now() - g.at < LOOP_MS);
}

async function fetchVersion() {
    try {
        const r = await fetch("/api/version", { cache: "no-store", credentials: "same-origin" });
        if (!r.ok) return "";
        const j = await r.json();
        return j && typeof j.v === "string" ? j.v : "";
    } catch (e) {
        return "";
    }
}

export function check() {
    if (inFlight) return inFlight;
    checkedAt = Date.now();
    inFlight = fetchVersion().then((v) => {
        inFlight = null;
        if (!v) return;
        // a page served without the stamp (an old server) learns it here
        if (!running) { running = v; return; }
        if (v === running || v === pending) return;
        // we already reloaded for this one and still came up short of it:
        // take what the server gave us rather than reload again
        if (reloadedRecently(v)) { running = v; return; }
        pending = v;
        safeSince = 0;
        startWatch();
    });
    return inFlight;
}

// a socket just opened (a fresh game or a reconnect after a restart)
export function onSocketOpen() {
    openedAt = Date.now();
    if (Date.now() - checkedAt > SOCKET_CHECK_GAP_MS) check();
}

const onMenu = () => !global.gameLoading && !global.gameStart && !document.body.classList.contains("in-game");

// an account pane or form is open (the first-visit "guest or account?"
// choice is fine to reload over, it has nothing to lose)
function menuBusy() {
    try {
        const choosing = welcome.isOpen() && welcome.currentView() === "choose";
        if (ui.hasLayers() && !choosing) return true;
    } catch (e) { /* */ }
    try { if (window.dwParty && window.dwParty.state().arming) return true; } catch (e) { /* */ }
    return Date.now() - lastKeyAt < TYPING_MS;
}

// "menu", "later" (in game, safe once settled), "hold" (dead, the card's
// wait not up yet) or "" (keep playing)
function moment() {
    if (onMenu()) return menuBusy() ? "" : "menu";
    // just joined on an old client (a tab left open over a deploy can't draw
    // the new map, the "void"): nothing to lose yet, reload now
    if (openedAt && Date.now() - openedAt < FRESH_MS && !global.died && !raidFinale.active() && !global.tutorialMode) return "now";
    if (global.tutorialMode || global.launchingTutorial) return "";
    if (global.disconnected && !global.autoReconnect) return "later";
    if (raidFinale.active()) return raidFinale.holdsCeremony() ? "" : "later";
    if (!global.died) return "";
    if (global.respawnPending || global.raidQueued || rankCeremony.isPlaying()) return "";
    // the death card's 3 s wait: let it read first, the reload comes after
    if (global.raidRespawnAt > 0 && performance.now() < global.raidRespawnAt) return "hold";
    return "later";
}

function reload(rejoin) {
    try { sessionStorage.setItem(GUARD_KEY, JSON.stringify({ v: pending, at: Date.now() })); } catch (e) { /* */ }
    if (rejoin) { try { sessionStorage.setItem(REJOIN_KEY, String(Date.now())); } catch (e) { /* */ } }
    stopWatch();
    // app.js asks "leave site?" while a game is live
    try { window.onbeforeunload = null; } catch (e) { /* */ }
    location.reload();
}

function note() {
    if (noteShown === pending || !document.body.classList.contains("in-game")) return;
    noteShown = pending;
    const sub = raidFinale.active() ? "Refreshing after the results" : "Refreshing after this life";
    try { gameToasts.note("update", "Update ready", { tag: "Update", sub, ms: 8000 }); } catch (e) { /* */ }
}

function step() {
    if (!pending) return stopWatch();
    const m = moment();
    if (m === "menu" || m === "now") return reload(m === "now");
    // dead with an update waiting: the reload comes once the card's 3 s are
    // up, so Play again stays off from the moment you die (app.js, canvas.js)
    global.updateHoldsRespawn = (m === "later" || m === "hold") && global.died;
    if (m !== "later") { safeSince = 0; note(); return; }
    const now = Date.now();
    if (!safeSince) safeSince = now;
    if (now - safeSince >= (global.died ? DEAD_SETTLE_MS : SETTLE_MS)) reload();
}

function startWatch() {
    if (tick) return;
    step();
    if (pending) tick = setInterval(step, 500);
}
function stopWatch() {
    clearInterval(tick);
    tick = 0;
}

// Play (app.js startGame): a tab that slept (hidden, or no check this
// minute) asks first, so an old client never joins a new server.
// -> Promise<true when it is reloading instead>
export function beforePlay() {
    if (pending && !reloadedRecently(pending)) { reload(); return Promise.resolve(true); }
    if (checkedAt && Date.now() - checkedAt < CHECK_MS && hiddenAt < checkedAt) return Promise.resolve(false);
    const late = new Promise((r) => setTimeout(() => r(false), PLAY_WAIT_MS));
    const asked = check().then(() => {
        if (pending && !reloadedRecently(pending)) { reload(); return true; }
        return false;
    });
    return Promise.race([asked, late]);
}

export function afterUpdate(onSame, onFail) {
    const from = Date.now();
    const poll = () => {
        fetchVersion().then((v) => {
            if (!v) {
                if (Date.now() - from > UPDATE_WAIT_MS) { if (onFail) onFail(); return; }
                setTimeout(poll, UPDATE_POLL_MS);
                return;
            }
            checkedAt = Date.now();
            if (running && v !== running && !reloadedRecently(v)) { pending = v; reload(true); return; }
            if (!running) running = v;
            onSame();
        });
    };
    setTimeout(poll, UPDATE_POLL_MS);
}

function init() {
    addEventListener("keydown", () => { lastKeyAt = Date.now(); }, true);
    setInterval(() => { if (!document.hidden) check(); }, CHECK_MS);
    document.addEventListener("visibilitychange", () => {
        if (document.hidden) { hiddenAt = Date.now(); return; }
        if (Date.now() - checkedAt > CHECK_MS) check();
    });
    if (!running) check();
    window.dwVersion = {
        check, onSocketOpen, beforePlay, afterUpdate,
        // QA: what this tab runs, what it is waiting to load, and why not yet
        state: () => ({ running, pending, moment: pending ? moment() : "", safeFor: safeSince ? Date.now() - safeSince : 0 }),
    };
}
init();
