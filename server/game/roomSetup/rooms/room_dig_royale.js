const cfg = (typeof Config !== "undefined" && Config.dig_royale_terrain) || {};
const roomWidth  = cfg.room_width  ?? 13;
const roomHeight = cfg.room_height ?? 13;

const room = Array(roomHeight).fill(null).map(() => Array(roomWidth).fill(tileClass.normal));

if (roomWidth === 20 && roomHeight === 20 && !(typeof Config !== "undefined" && (Config.tutorial || Config.royale_duos))) {
    const { BASE_TILES, BLUE, RED } = require('../../terrain/teamLayout.js');
    for (const [team, plain, guarded] of [[BLUE, tileClass.royaleBase1, tileClass.royaleBaseGuarded1], [RED, tileClass.royaleBase2, tileClass.royaleBaseGuarded2]]) {
        const b = BASE_TILES[team];
        for (let gy = b.gy0; gy <= b.gy1; gy++) for (let gx = b.gx0; gx <= b.gx1; gx++) room[gy][gx] = plain;
        for (const [gx, gy] of b.prot) room[gy][gx] = guarded;
    }
}

module.exports = room;
