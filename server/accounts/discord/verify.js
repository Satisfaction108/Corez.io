// Discord interaction signatures: Ed25519 over (timestamp + raw body) with
// the application's public key (hex, 32 raw bytes) wrapped as SPKI DER so
// node:crypto can load it. Timestamps more than 5 minutes off are refused,
// so a captured request cannot be replayed later.
'use strict';

const nodeCrypto = require('crypto');

const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const MAX_SKEW_S = 5 * 60;

const keyCache = new Map();   // hex -> KeyObject
function keyFor(publicKeyHex) {
    let k = keyCache.get(publicKeyHex);
    if (!k) {
        const raw = Buffer.from(publicKeyHex, 'hex');
        if (raw.length !== 32) throw new Error('Ed25519 public key must be 32 bytes');
        k = nodeCrypto.createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
        keyCache.set(publicKeyHex, k);
    }
    return k;
}

// -> true only for a valid, fresh signature. Never throws.
function verify(publicKeyHex, signatureHex, timestamp, rawBody, nowMs = Date.now()) {
    try {
        if (!publicKeyHex || typeof signatureHex !== 'string' || typeof timestamp !== 'string') return false;
        if (!/^[0-9a-f]{128}$/i.test(signatureHex) || !/^\d{1,12}$/.test(timestamp)) return false;
        if (Math.abs(nowMs / 1000 - Number(timestamp)) > MAX_SKEW_S) return false;
        const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody == null ? '' : rawBody), 'utf8');
        return nodeCrypto.verify(null, Buffer.concat([Buffer.from(timestamp, 'utf8'), body]), keyFor(publicKeyHex.toLowerCase()), Buffer.from(signatureHex, 'hex'));
    } catch (e) {
        return false;
    }
}

module.exports = { verify, SPKI_PREFIX, MAX_SKEW_S };
