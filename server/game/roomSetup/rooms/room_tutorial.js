// Tutorial room: a PLOT_COLS x PLOT_ROWS grid of identical learner arenas,
// each a small Dig Royale practice ground (open field, a rock wall, one
// vault, one base pad, one shop pad), separated by gutters of plain tiles
// that nobody can see across. There are no team base tiles: Dig Royale has
// no teams, so nothing here should either.
//
// Room files are evaluated with `tileClass` in scope (see loaders/global.js).

const plots = require('../../terrain/tutorialPlots.js');

const roomWidth = plots.ROOM_TILES_X;
const roomHeight = plots.ROOM_TILES_Y;

const room = Array(roomHeight).fill(null).map(() => Array(roomWidth).fill(tileClass.normal));

module.exports = room;
