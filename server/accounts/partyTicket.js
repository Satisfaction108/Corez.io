// Duo party tickets: a short-lived HMAC-signed pass the main thread hands a
// party member (POST /api/party/ticket) and the duo game server checks when
// that member's socket says hello ('DQ' packet). It carries who the member
// is and who their mate is, so the game server can put both on one team
// without ever asking the main thread.
//
//   {pid, mk, mates:[mk...], n, fill, exp}
//     pid    party id (random, main thread)
//     mk     member key: 'u:<internal user id>' for an account, 'g:<id>' for
//            a guest party member (random, main thread)
//     mates  every member key in the party, this one included
//     n      the display name at issue time (guests; accounts use the session)
//
// Format: b64url(json) + '.' + b64url(hmac-sha256). The purpose tag rides
// inside the signed JSON, the same shape as crypto.sign in this folder.
//
// The secret: the main thread picks it once at boot (derived from
// SESSION_SECRET when there is one, else random) and hands it to game
// workers through process.env.PARTY_TICKET_SECRET, which a worker copies
// when it is constructed. Workers never derive their own (a dev boot's
// random session secret differs per thread).
'use strict';

const nodeCrypto = require('crypto');

const PURPOSE = 'duo1';
const TTL_MS = 10 * 60 * 1000;
const MAX_LEN = 2048;

let secret = null;

function deriveFrom(sessionSecret) {
    if (!sessionSecret) return nodeCrypto.randomBytes(32).toString('base64url');
    return nodeCrypto.createHmac('sha256', String(sessionSecret)).update('party-ticket-v1').digest('base64url');
}

// Main thread, before any game worker starts.
function initMain(sessionSecret) {
    if (!process.env.PARTY_TICKET_SECRET) process.env.PARTY_TICKET_SECRET = deriveFrom(sessionSecret);
    secret = process.env.PARTY_TICKET_SECRET;
    return secret;
}

function key() {
    if (!secret) secret = process.env.PARTY_TICKET_SECRET || null;
    return secret;
}

function hmac(body, k) {
    return nodeCrypto.createHmac('sha256', k).update(body).digest();
}

function sign(data, now = Date.now(), ttlMs = TTL_MS) {
    const k = key();
    if (!k) throw new Error('party tickets: no secret');
    const body = Buffer.from(JSON.stringify({ ...data, _p: PURPOSE, exp: now + ttlMs })).toString('base64url');
    return body + '.' + hmac(body, k).toString('base64url');
}

const MK_RE = /^[ug]:[A-Za-z0-9_-]{1,40}$/;

// -> the payload, or null (bad signature, expired, malformed)
function verify(token, now = Date.now()) {
    const k = key();
    if (!k || typeof token !== 'string' || !token || token.length > MAX_LEN) return null;
    const dot = token.indexOf('.');
    if (dot <= 0 || dot !== token.lastIndexOf('.')) return null;
    const body = token.slice(0, dot);
    let sig;
    try { sig = Buffer.from(token.slice(dot + 1), 'base64url'); } catch (e) { return null; }
    const want = hmac(body, k);
    if (sig.length !== want.length || !nodeCrypto.timingSafeEqual(sig, want)) return null;
    let d;
    try { d = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch (e) { return null; }
    if (!d || typeof d !== 'object' || d._p !== PURPOSE) return null;
    if (typeof d.exp !== 'number' || d.exp <= now) return null;
    if (typeof d.pid !== 'string' || !/^[A-Za-z0-9_-]{6,40}$/.test(d.pid)) return null;
    if (typeof d.mk !== 'string' || !MK_RE.test(d.mk)) return null;
    const mates = Array.isArray(d.mates) ? d.mates.filter(m => typeof m === 'string' && MK_RE.test(m)).slice(0, 2) : [];
    if (!mates.includes(d.mk)) return null;
    return {
        pid: d.pid, mk: d.mk, mates, exp: d.exp,
        n: typeof d.n === 'string' ? d.n.slice(0, 24) : '',
        fill: d.fill !== false,
    };
}

// Tests only.
function _setSecret(s) { secret = s; }

module.exports = { initMain, sign, verify, deriveFrom, TTL_MS, PURPOSE, _setSecret };
