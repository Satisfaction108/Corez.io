const session = require('../../tutorialSession.js');

// Housekeeping only - the interesting work (plot claiming, scripted bots) is
// driven by the client's lesson progress through sockets.js.
class Tutorial {
    constructor(gameManager) { this.gameManager = gameManager; }
    start() {}
    // 1 Hz housekeeping.
    loop() {
        session.tickReap();
    }
    // Every game tick (gamemodeManager "quickloop"): anything that moves an
    // entity or guards the learner has to run at tick rate or it shows up as
    // a once-a-second teleport.
    quickloop() {
        session.tickLeash();
        session.tickBaseGuard();
        session.tickSafety();
        // After the guards, so a glide in progress is not fought by the fence
        // on the same tick.
        session.tickGlide();
    }
    reset() {}
    redefine(gm) { this.gameManager = gm; }
}

module.exports = { Tutorial };
