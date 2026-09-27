// Map size is the strongest density lever, so it lives in the gamemode config
// (dig_wars_terrain.room_width / room_height). game.js feeds the room's tile
// dimensions into mapGen, and canyons, outposts and core chambers are placed
// as fractions of the grid span, so these two numbers move the whole world.
//
// Deliberately wide, not square: the war runs left-to-right between the two
// base columns, so width is the risk gradient (the haul has to stay long
// enough to be scary) while height is only spread. A tall world splits a thin
// population across the upper canyon, lower canyon and Deep Core outpost.
const cfg = (typeof Config !== "undefined" && Config.dig_wars_terrain) || {};
const roomWidth  = cfg.room_width  ?? 13;
const roomHeight = cfg.room_height ?? 9;

const room = Array(roomHeight).fill(null).map(() => Array(roomWidth).fill(tileClass.normal));

for (let y = 0; y < roomHeight; y++) {
    room[y][0] = tileClass.base1;
    room[y][roomWidth - 1] = tileClass.base2;
}

module.exports = room;
