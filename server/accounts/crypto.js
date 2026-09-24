// Password hashing, tokens, signed cookies and Crockford base32 ids.
'use strict';

const nodeCrypto = require('crypto');
const config = require('./config');

// scrypt with the parameters stored in the hash string, so they can be
// raised later without breaking old hashes: 'scrypt$N$r$p$saltB64$hashB64'.
const SCRYPT = { N: 1 << 15, r: 8, p: 1, keylen: 64, saltBytes: 16, maxmem: 64 * 1024 * 1024 };

// Every scrypt runs through one gate: at most 2 at a time, so the other
// libuv threadpool users (static file reads, DNS, zlib) always keep a thread,
// and at most 32 more waiting. Past that a hash fails fast with BusyError,
// which the HTTP layer answers as 503 busy + Retry-After.
const SCRYPT_GATE = { max: 2, queueMax: 32 };
const gate = { active: 0, queue: [] };

class BusyError extends Error {
    constructor() {
        super('password hashing is saturated');
        this.name = 'BusyError';
        this.code = 'busy';
    }
}

function gateRelease() {
    gate.active--;
    const next = gate.queue.shift();
    if (next) next();
}

function rawScrypt(secret, salt, keylen, params) {
    return new Promise((resolve, reject) => {
        try {
            nodeCrypto.scrypt(secret, salt, keylen, { N: params.N, r: params.r, p: params.p, maxmem: SCRYPT.maxmem }, (err, key) => {
                gateRelease();
                if (err) reject(err);
                else resolve(key);
            });
        } catch (e) {
            // Bad parameters throw synchronously; the slot is still ours to free.
            gateRelease();
            reject(e);
        }
    });
}

function scrypt(secret, salt, keylen, params) {
    if (gate.active < SCRYPT_GATE.max) {
        gate.active++;
        return rawScrypt(secret, salt, keylen, params);
    }
    if (gate.queue.length >= SCRYPT_GATE.queueMax) return Promise.reject(new BusyError());
    return new Promise((resolve, reject) => {
        gate.queue.push(() => {
            gate.active++;
            rawScrypt(secret, salt, keylen, params).then(resolve, reject);
        });
    });
}

// {active, queued}, for tests and diagnostics.
function scryptLoad() {
    return { active: gate.active, queued: gate.queue.length };
}

// NFKC so the same password typed on different keyboards/IMEs hashes the same.
function normalizeSecret(s) {
    return String(s).normalize('NFKC');
}

async function hashPassword(password) {
    const salt = nodeCrypto.randomBytes(SCRYPT.saltBytes);
    const key = await scrypt(normalizeSecret(password), salt, SCRYPT.keylen, SCRYPT);
    return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), key.toString('base64')].join('$');
}

function parseHash(stored) {
    if (typeof stored !== 'string') return null;
    const parts = stored.split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
    const N = Number(parts[1]), r = Number(parts[2]), p = Number(parts[3]);
    // Bounds keep a corrupted row from asking for gigabytes of memory.
    if (!Number.isInteger(N) || N < 2 || N > (1 << 20) || (N & (N - 1)) !== 0) return null;
    if (!Number.isInteger(r) || r < 1 || r > 32 || !Number.isInteger(p) || p < 1 || p > 16) return null;
    if (128 * N * r * p > SCRYPT.maxmem) return null;
    const salt = Buffer.from(parts[4], 'base64');
    const hash = Buffer.from(parts[5], 'base64');
    if (salt.length < 8 || hash.length < 16 || hash.length > 128) return null;
    return { N, r, p, salt, hash };
}

let dummyHash = null;   // Promise of the hash, shared by concurrent first callers
// Same cost as a real verify (and through the same gate), so "no such user"
// and "wrong password" take the same time.
async function dummyVerify(password) {
    if (!dummyHash) {
        const p = hashPassword('dummy-password-' + nodeCrypto.randomBytes(8).toString('hex'));
        dummyHash = p;
        p.catch(() => { if (dummyHash === p) dummyHash = null; });
    }
    await verifyPassword(password, await dummyHash);
    return false;
}

async function verifyPassword(password, stored) {
    if (typeof password !== 'string') password = '';
    const parsed = parseHash(stored);
    if (!parsed) return dummyVerify(password);
    let key;
    try {
        key = await scrypt(normalizeSecret(password), parsed.salt, parsed.hash.length, parsed);
    } catch (e) {
        if (e instanceof BusyError) throw e;
        return false;
    }
    return key.length === parsed.hash.length && nodeCrypto.timingSafeEqual(key, parsed.hash);
}

function randomToken(bytes = 32) {
    return nodeCrypto.randomBytes(bytes).toString('base64url');
}

function sha256(s) {
    return nodeCrypto.createHash('sha256').update(String(s)).digest('hex');
}

function safeEqual(a, b) {
    const x = Buffer.from(String(a));
    const y = Buffer.from(String(b));
    return x.length === y.length && nodeCrypto.timingSafeEqual(x, y);
}

// Signed, expiring values for cookies: 'b64url(json).b64url(hmac)'. The
// purpose is inside the signed JSON, so an OAuth-state cookie can never be
// replayed as a pending-signup cookie.
function hmac(data, secret) {
    return nodeCrypto.createHmac('sha256', secret || config.sessionSecret).update(data).digest();
}

function sign(purpose, data, ttlMs, now = Date.now()) {
    const body = Buffer.from(JSON.stringify({ ...data, _p: purpose, exp: now + ttlMs })).toString('base64url');
    return body + '.' + hmac(body).toString('base64url');
}

function verifySigned(purpose, token, now = Date.now()) {
    if (typeof token !== 'string' || token.length > 4096 || !config.sessionSecret) return null;
    const dot = token.indexOf('.');
    if (dot <= 0 || dot !== token.lastIndexOf('.')) return null;
    const body = token.slice(0, dot);
    const sig = Buffer.from(token.slice(dot + 1), 'base64url');
    const want = hmac(body);
    if (sig.length !== want.length || !nodeCrypto.timingSafeEqual(sig, want)) return null;
    let data;
    try {
        data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    } catch (e) {
        return null;
    }
    if (!data || typeof data !== 'object' || data._p !== purpose) return null;
    if (typeof data.exp !== 'number' || data.exp <= now) return null;
    return data;
}

// Crockford base32: no I, L, O, U, so codes survive being read aloud.
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CROCKFORD_RE = /^[0-9A-HJKMNP-TV-Z]*$/;

function crockfordEncode(buf) {
    let out = '', bits = 0, value = 0;
    for (const byte of buf) {
        value = (value << 8) | byte;
        bits += 8;
        while (bits >= 5) {
            out += CROCKFORD[(value >>> (bits - 5)) & 31];
            bits -= 5;
        }
        value &= (1 << bits) - 1;
    }
    if (bits > 0) out += CROCKFORD[(value << (5 - bits)) & 31];
    return out;
}

// Uppercase, drop spaces/dashes, and fold the look-alikes Crockford allows.
function crockfordNormalize(s) {
    return String(s == null ? '' : s)
        .toUpperCase()
        .replace(/[\s\-_]+/g, '')
        .replace(/O/g, '0')
        .replace(/[IL]/g, '1');
}

function isCrockford(s) {
    return typeof s === 'string' && CROCKFORD_RE.test(s);
}

// 'DW-' + 8 chars (40 bits). Uniqueness is enforced by the users.public_id
// UNIQUE constraint; users.create retries on a collision.
function newPublicId() {
    return 'DW-' + crockfordEncode(nodeCrypto.randomBytes(5));
}

// 'XXXX-XXXX-XXXX' (60 bits).
function newRecoveryCode() {
    const c = crockfordEncode(nodeCrypto.randomBytes(8)).slice(0, 12);
    return `${c.slice(0, 4)}-${c.slice(4, 8)}-${c.slice(8, 12)}`;
}

// Canonical form that gets hashed: 12 Crockford chars, or null.
function normalizeRecoveryCode(s) {
    const n = crockfordNormalize(s);
    return n.length === 12 && isCrockford(n) ? n : null;
}

module.exports = {
    SCRYPT,
    SCRYPT_GATE,
    BusyError,
    scryptLoad,
    hashPassword,
    verifyPassword,
    dummyVerify,
    randomToken,
    sha256,
    safeEqual,
    sign,
    verifySigned,
    crockfordEncode,
    crockfordNormalize,
    isCrockford,
    newPublicId,
    newRecoveryCode,
    normalizeRecoveryCode,
};
