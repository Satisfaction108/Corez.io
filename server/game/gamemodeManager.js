const { Siege } = require("./gamemodes/scripts/siege.js");
const { Assault } = require("./gamemodes/scripts/assault.js");
const { Tag } = require("./gamemodes/scripts/tag.js");
const { Domination } = require("./gamemodes/scripts/dominator.js");
const { Mothership } = require("./gamemodes/scripts/mothership.js");
const { Sandbox } = require("./gamemodes/scripts/sandbox.js");
const { Train } = require("./gamemodes/scripts/trainwars.js");
const { Maze } = require("./gamemodes/scripts/maze.js");
const { Outbreak } = require("./gamemodes/scripts/outbreak.js");
const { ClanWars } = require("./gamemodes/scripts/clan_wars.js");
const { GroupHandler } = require("./gamemodes/scripts/groups.js");
const { DigWars } = require("./gamemodes/scripts/dig_wars.js");
const { DigRoyale } = require("./gamemodes/scripts/dig_royale.js");
const { Tutorial } = require("./gamemodes/scripts/tutorial.js");

class gamemodeManager {
    constructor() {
        this.gameSiege = new Siege(global.gameManager);
        this.gameAssault = new Assault(global.gameManager);
        this.gameTag = new Tag(global.gameManager);
        this.gameDomination = new Domination(global.gameManager);
        this.gameMothership = new Mothership(global.gameManager);
        this.gameSandbox = new Sandbox(global.gameManager);
        this.gameMaze = new Maze(global.gameManager, null);
        this.gameTrain = new Train();
        this.gameOutbreak = new Outbreak(global.gameManager);
        this.gameClanwars = new ClanWars(global.gameManager);
        this.gameGroups = new GroupHandler(global.gameManager);
        this.gameDigWars = new DigWars(global.gameManager);
        this.gameDigRoyale = new DigRoyale(global.gameManager);
        this.gameTutorial = new Tutorial(global.gameManager);
    }

    request(type) {
        if (type == "start") {
            if (Config.siege) this.gameSiege.start(Config.maze_type ?? false);
            if (Config.assault) this.gameAssault.start();
            if (Config.tag) Config.tag_data.initAndStart();
            if (Config.domination) this.gameDomination.start();
            if (Config.mothership) this.gameMothership.start();
            if (Config.maze_type !== undefined && !Config.siege) this.gameMaze.generate();
            if (Config.outbreak) this.gameOutbreak.start();
            if (Config.dig_wars) this.gameDigWars.start();
            if (Config.dig_royale) this.gameDigRoyale.start();
            if (Config.tutorial) this.gameTutorial.start();
        }
        if (type == "loop") {
            global.gameManager.lagLogger.set();
            if (Config.siege) this.gameSiege.loop();
            if (Config.mothership) this.gameMothership.loop();
            if (Config.tutorial) this.gameTutorial.loop();
            if (Config.dig_wars) this.gameDigWars.loop();
            if (Config.dig_royale) this.gameDigRoyale.loop();
            global.gameManager.lagLogger.mark();
            if (global.gameManager.lagLogger.totalTime > 100) {
                console.log("Gamemode loop is taking a long time!");
                console.log(`Gamemode loop took ${global.gameManager.lagLogger.totalTime}ms to complete!`);
                console.log(`Gamemode loop log history: (Last ${global.gameManager.lagLogger.sum.length} entries)`);
                console.log(global.gameManager.lagLogger.sum.map(entry => `Run at: ${entry.at}. Time: ${entry.time}.`).join("\n"));
            }
        }
        if (type == "quickloop") {
            if (Config.sandbox) this.gameSandbox.update();
            if (Config.train) this.gameTrain.loop();
            // Every tick, not in the 1 Hz "loop": the tutorial's glide, bot
            // leash and health floor are motion and safety, and at 1 Hz the
            // glide landed as one jump and bots snapped back once a second.
            if (Config.tutorial) this.gameTutorial.quickloop();
        }
    }

    terminate() {
        if (Config.siege) this.gameSiege.reset();
        if (Config.assault) this.gameAssault.reset();
        if (Config.tag) Config.tag_data.resetAndStop();
        if (Config.domination) this.gameDomination.reset();
        if (Config.mothership) this.gameMothership.reset();
        if (Config.clan_wars) this.gameClanwars.reset();
        if (Config.dig_wars) this.gameDigWars.reset();
        if (Config.dig_royale) this.gameDigRoyale.reset();
        if (Config.tutorial) this.gameTutorial.reset();
    }

    redefine(theshit) {
        this.gameSiege.redefine(theshit);
        this.gameAssault.redefine(theshit);
        this.gameTag.redefine(theshit);
        this.gameSandbox.redefine(theshit);
        this.gameMaze.redefine(Config.maze_type);
        this.gameClanwars.redefine(theshit);
        this.gameGroups.redefine(theshit);
        this.gameDigWars.redefine(theshit);
        this.gameDigRoyale.redefine(theshit);
        this.gameTutorial.redefine(theshit);
    }
}

module.exports = { gamemodeManager };