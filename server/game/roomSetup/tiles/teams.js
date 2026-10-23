let spawnPermanentBaseProtector = (loc, team) => {
    let o = new Entity(loc);
    o.define('baseProtector');
    o.team = team;
    o.color.base = getTeamColor(team);
    o.on('dead', () => spawnPermanentBaseProtector(loc, team));
},
teamCheck = (tile, team) => {
    for (let i = 0; i < tile.entities.length; i++) {
        let entity = tile.entities[i];
        // Dig Wars: loose gemdust is neutral loot; the base zone must not
        // vaporize it (outer wall rocks overlap the base apron, so their
        // gems would die the same tick they spawn)
        if (entity.isGemPickup) continue;
        if (entity.team !== team && !entity.ac && !entity.master.master.ac && !entity.isArenaCloser && !entity.master.master.isArenaCloser && !entity.baseImmune && !entity.master.master.baseImmune) {
            // Straight kill() by the tile: no damage, no bullet, nobody in the
            // killers list. Tag it first so the death screen can say what
            // happened instead of "nobody finished you off".
            entity.deathCause = "base";
            entity.kill()
        };
    }
},
teamRoomCheck = (tile, team, room) => {
    if (!room.spawnable[team]) room.spawnable[team] = [];
    room.spawnable[team].push(tile);
};

// Team -1 (blue)
tileClass.base1 = new Tile({
    COLOR: "blue",
    INIT: (tile, room) => teamRoomCheck(tile, TEAM_BLUE, room),
    TICK: tile => teamCheck(tile, TEAM_BLUE)
})
tileClass.baseprotected1 = new Tile({
    COLOR: "blue",
    VISIBLE_FROM_BLACKOUT: true,
    INIT: (tile, room) => {
        teamRoomCheck(tile, TEAM_BLUE, room),
        spawnPermanentBaseProtector(tile.loc, TEAM_BLUE);
    },
    TICK: tile => teamCheck(tile, TEAM_BLUE)
})

// Team -2 (Red)
tileClass.base2 = new Tile({
    COLOR: "red",
    INIT: (tile, room) => teamRoomCheck(tile, TEAM_RED, room),
    TICK: tile => teamCheck(tile, TEAM_RED)
})
tileClass.baseprotected2 = new Tile({
    COLOR: "red",
    VISIBLE_FROM_BLACKOUT: true,
    INIT: (tile, room) => {
        teamRoomCheck(tile, TEAM_RED, room),
        spawnPermanentBaseProtector(tile.loc, TEAM_RED);
    },
    TICK: tile => teamCheck(tile, TEAM_RED)
})

// Team -3 (Red)
tileClass.base3 = new Tile({
    COLOR: "red",
    INIT: (tile, room) => teamRoomCheck(tile, TEAM_RED, room),
    TICK: tile => teamCheck(tile, TEAM_RED)
})
tileClass.baseprotected3 = new Tile({
    COLOR: "red",
    VISIBLE_FROM_BLACKOUT: true,
    INIT: (tile, room) => {
        teamRoomCheck(tile, TEAM_RED, room),
        spawnPermanentBaseProtector(tile.loc, TEAM_RED);
    },
    TICK: tile => teamCheck(tile, TEAM_RED)
})

// Team -4 (Purple)
tileClass.base4 = new Tile({
    COLOR: "magenta",
    INIT: (tile, room) => teamRoomCheck(tile, TEAM_PURPLE, room),
    TICK: tile => teamCheck(tile, TEAM_PURPLE)
})
tileClass.baseprotected4 = new Tile({
    COLOR: "magenta",
    VISIBLE_FROM_BLACKOUT: true,
    INIT: (tile, room) => {
        teamRoomCheck(tile, TEAM_PURPLE, room),
        spawnPermanentBaseProtector(tile.loc, TEAM_PURPLE);
    },
    TICK: tile => teamCheck(tile, TEAM_PURPLE)
})

// Team -5 (Yellow)
tileClass.base5 = new Tile({
    COLOR: "mustard",
    INIT: (tile, room) => teamRoomCheck(tile, TEAM_YELLOW, room),
    TICK: tile => teamCheck(tile, TEAM_YELLOW)
})
tileClass.baseprotected5 = new Tile({
    COLOR: "mustard",
    VISIBLE_FROM_BLACKOUT: true,
    INIT: (tile, room) => {
        teamRoomCheck(tile, TEAM_YELLOW, room),
        spawnPermanentBaseProtector(tile.loc, TEAM_YELLOW);
    },
    TICK: tile => teamCheck(tile, TEAM_YELLOW)
})

// Team -6 (Orange)
tileClass.base6 = new Tile({
    COLOR: "tangerine",
    INIT: (tile, room) => teamRoomCheck(tile, TEAM_ORANGE, room),
    TICK: tile => teamCheck(tile, TEAM_ORANGE)
})
tileClass.baseprotected6 = new Tile({
    COLOR: "tangerine",
    VISIBLE_FROM_BLACKOUT: true,
    INIT: (tile, room) => {
        teamRoomCheck(tile, TEAM_ORANGE, room),
        spawnPermanentBaseProtector(tile.loc, TEAM_ORANGE);
    },
    TICK: tile => teamCheck(tile, TEAM_ORANGE)
})

// Team -7 (Brown)
tileClass.base7 = new Tile({
    COLOR: "brown",
    INIT: (tile, room) => teamRoomCheck(tile, TEAM_BROWN, room),
    TICK: tile => teamCheck(tile, TEAM_BROWN)
})
tileClass.baseprotected7 = new Tile({
    COLOR: "brown",
    VISIBLE_FROM_BLACKOUT: true,
    INIT: (tile, room) => {
        teamRoomCheck(tile, TEAM_BROWN, room),
        spawnPermanentBaseProtector(tile.loc, TEAM_BROWN);
    },
    TICK: tile => teamCheck(tile, TEAM_BROWN)
})

// Team -8 (Cyan)
tileClass.base8 = new Tile({
    COLOR: "cyan",
    INIT: (tile, room) => teamRoomCheck(tile, TEAM_CYAN, room),
    TICK: tile => teamCheck(tile, TEAM_CYAN)
})
tileClass.baseprotected8 = new Tile({
    COLOR: "cyan",
    VISIBLE_FROM_BLACKOUT: true,
    INIT: (tile, room) => {
        teamRoomCheck(tile, TEAM_CYAN, room),
        spawnPermanentBaseProtector(tile.loc, TEAM_CYAN);
    },
    TICK: tile => teamCheck(tile, TEAM_CYAN)
})

const royaleTeamsOn = () => !!(global.Config && Config.royale_teams);
const royaleBaseTile = (team, guarded) => new Tile({
    COLOR: team === TEAM_BLUE ? "blue" : "red",
    NAME: "Royale Base " + (team === TEAM_BLUE ? "Blue" : "Red") + (guarded ? " Guarded" : ""),
    VISIBLE_FROM_BLACKOUT: true,
    DATA: { team, guarded },
    INIT: (tile, room) => {
        teamRoomCheck(tile, team, room);
        if (!royaleTeamsOn()) tile.color = "white";
    },
    TICK: tile => { if (royaleTeamsOn()) teamCheck(tile, team); }
});
tileClass.royaleBase1 = royaleBaseTile(TEAM_BLUE, false);
tileClass.royaleBaseGuarded1 = royaleBaseTile(TEAM_BLUE, true);
tileClass.royaleBase2 = royaleBaseTile(TEAM_RED, false);
tileClass.royaleBaseGuarded2 = royaleBaseTile(TEAM_RED, true);
