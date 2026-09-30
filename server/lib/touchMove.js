"use strict";
// The touch stick's analog move from the command packet's fifth field:
// 0 is none, otherwise two bytes (x, y), each 1..255 with 128 as zero.
// Mirrors public/client/touchInput.js packMove. Never longer than 1.
function unpackMove(n) {
    if (typeof n !== "number" || !(n > 0) || n > 65535 || n !== Math.floor(n)) return null;
    const qx = n >> 8, qy = n & 255;
    if (!qx || !qy) return null;
    let x = (qx - 1) / 127 - 1, y = (qy - 1) / 127 - 1;
    const len = Math.hypot(x, y);
    if (len > 1) { x /= len; y /= len; }
    if (len < 0.05) return null;
    return { x, y };
}

module.exports = { unpackMove };
