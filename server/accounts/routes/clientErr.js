'use strict';

const seen = new Map();
const DAY_MS = 24 * 60 * 60 * 1000;

function clip(v, n) { return String(v == null ? '' : v).replace(/[\r\n\t]+/g, ' | ').replace(/[^\x20-\x7e]/g, '?').slice(0, n); }

function postClientErr(ctx) {
    ctx.charge(['clientErr', 'ip:' + ctx.ipKey]);
    const b = ctx.body || {};
    const msg = clip(b.m, 200);
    if (msg) {
        const stack = clip(b.s, 700);
        const key = msg + '|' + stack.slice(0, 160);
        const row = seen.get(key) || { n: 0, at: 0 };
        row.n++;
        if (!row.at || ctx.now - row.at > 10 * 60 * 1000) {
            row.at = ctx.now;
            console.warn('[clienterr] x' + row.n + ' ' + clip(b.w, 24) + ' ' + clip(b.v, 40) + ' ' + msg + ' @ ' + stack);
        }
        seen.set(key, row);
        if (seen.size > 300) for (const [k, r] of seen) if (ctx.now - r.at > DAY_MS || seen.size > 300) seen.delete(k);
    }
    ctx.noContent();
}

function register(router) {
    router.add('POST', '/api/clienterr', postClientErr);
}

module.exports = { register };
