// Main <-> game message bus.
//
// Main thread -> game: toGame(msg) calls every onGame listener registered in
// this thread (the game runs here in SINGLE_PROCESS mode) and hands the
// message to the worker poster, if the wiring set one, for a game running
// in a worker thread. In that worker the wiring feeds parentPort messages
// into its own copy of this module with toGame(msg).
//
// Game -> main: toMain(msg) goes to the main poster in a worker, or straight
// to fromGame('main', msg) in the main thread; onMain listeners receive
// (serverId, msg).
//
// Phase 1 messages (main -> game):
//   {t:'kick', userId, reason}   close every game socket of that account with
//                                KO [reason] and no auto-reconnect.
'use strict';

const gameListeners = new Set();
const mainListeners = new Set();
let workerPoster = null;
let mainPoster = null;

function safeCall(fn, ...args) {
    try {
        fn(...args);
    } catch (e) {
        console.error('[accounts] bus listener failed: ' + ((e && e.stack) || e));
    }
}

function toGame(msg) {
    for (const fn of Array.from(gameListeners)) safeCall(fn, msg);
    if (workerPoster) safeCall(workerPoster, msg);
}

// -> unsubscribe function
function onGame(fn) {
    gameListeners.add(fn);
    return () => gameListeners.delete(fn);
}

function setWorkerPoster(fn) {
    workerPoster = typeof fn === 'function' ? fn : null;
}

function toMain(msg) {
    if (mainPoster) safeCall(mainPoster, msg);
    else fromGame('main', msg);
}

function fromGame(serverId, msg) {
    for (const fn of Array.from(mainListeners)) safeCall(fn, serverId, msg);
}

function onMain(fn) {
    mainListeners.add(fn);
    return () => mainListeners.delete(fn);
}

function setMainPoster(fn) {
    mainPoster = typeof fn === 'function' ? fn : null;
}

module.exports = { toGame, onGame, setWorkerPoster, toMain, fromGame, onMain, setMainPoster };
