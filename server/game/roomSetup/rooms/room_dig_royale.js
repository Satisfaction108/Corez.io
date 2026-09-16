// Square tile grid of normal floor. The playable world is a rock circle
// carved in mapGen / royaleLayout - no team bases.
const cfg = (typeof Config !== "undefined" && Config.dig_royale_terrain) || {};
const roomWidth  = cfg.room_width  ?? 13;
const roomHeight = cfg.room_height ?? 13;

const room = Array(roomHeight).fill(null).map(() => Array(roomWidth).fill(tileClass.normal));

module.exports = room;
