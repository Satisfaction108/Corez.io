// Web Push, the wire side: message encryption (RFC 8291, aes128gcm from
// RFC 8188), VAPID (RFC 8292) and the POST to the browser's push service.
// node:crypto only, no packages.
//
// Keys come from the environment (config.webPush), base64url without padding:
//   WEB_PUSH_PUBLIC_KEY   65-byte uncompressed P-256 point (0x04 || x || y)
//   WEB_PUSH_PRIVATE_KEY  32-byte private scalar
// scripts/gen-vapid-keys.js makes a pair. The public key must never change
// once players have subscribed: their subscriptions are tied to it.
//
// encrypt() takes an optional fixed salt and sender key so the test can check
// it against the RFC 8291 example byte for byte; real sends always use fresh
// random ones.
'use strict';

const nodeCrypto = require('crypto');
const config = require('./config');

const RS = 4096;                       // record size; one record is plenty for a ping
const MAX_PLAIN = RS - 16 - 1;         // tag and the padding delimiter
const JWT_TTL_S = 12 * 60 * 60;        // VAPID allows up to 24 h
const SEND_TIMEOUT_MS = 10000;

const b64u = (buf) => Buffer.from(buf).toString('base64url');
function unb64u(s) {
    const str = String(s || '').trim().replace(/=+$/, '');
    if (!/^[A-Za-z0-9_-]*$/.test(str)) return null;
    return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

const hmac = (key, data) => nodeCrypto.createHmac('sha256', key).update(data).digest();

// ── keys ────────────────────────────────────────────────────────────────
// The parsed VAPID pair, or null (unset or broken: push stays off). Parsed
// once per distinct pair of strings.
let keyCache = { pub: null, priv: null, value: null, error: '' };
function parseKeys(pubStr, privStr) {
    const pub = unb64u(pubStr), d = unb64u(privStr);
    if (!pub || !d || !pubStr || !privStr) return { value: null, error: pubStr || privStr ? 'WEB_PUSH_PUBLIC_KEY / WEB_PUSH_PRIVATE_KEY are not base64url' : '' };
    if (pub.length !== 65 || pub[0] !== 4 || d.length !== 32) return { value: null, error: 'VAPID keys have the wrong size (want a 65-byte public point and a 32-byte private key)' };
    try {
        const ecdh = nodeCrypto.createECDH('prime256v1');
        ecdh.setPrivateKey(d);
        if (!ecdh.getPublicKey().equals(pub)) return { value: null, error: 'WEB_PUSH_PUBLIC_KEY does not belong to WEB_PUSH_PRIVATE_KEY' };
        const key = nodeCrypto.createPrivateKey({
            format: 'jwk',
            key: { kty: 'EC', crv: 'P-256', d: b64u(d), x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) },
        });
        return { value: { pub, pubB64: b64u(pub), key }, error: '' };
    } catch (e) {
        return { value: null, error: 'VAPID keys are not a valid P-256 pair' };
    }
}
function keys() {
    const w = config.webPush || {};
    if (keyCache.pub !== w.publicKey || keyCache.priv !== w.privateKey) {
        const r = parseKeys(w.publicKey, w.privateKey);
        keyCache = { pub: w.publicKey, priv: w.privateKey, value: r.value, error: r.error };
    }
    return keyCache.value;
}
const keyError = () => { keys(); return keyCache.error; };
const publicKey = () => { const k = keys(); return k ? k.pubB64 : ''; };

// A fresh pair for the generator script. -> {publicKey, privateKey} base64url
function generateKeys() {
    const ecdh = nodeCrypto.createECDH('prime256v1');
    ecdh.generateKeys();
    return { publicKey: b64u(ecdh.getPublicKey()), privateKey: b64u(ecdh.getPrivateKey()) };
}

// ── encryption (RFC 8291) ───────────────────────────────────────────────
// plaintext: Buffer | string. uaPublic: the subscription's p256dh (65 bytes),
// authSecret: its auth (16 bytes). opts.salt (16 bytes) and opts.asPrivate
// (32 bytes) fix the random parts, for the test vector only.
// -> Buffer: the aes128gcm body (86-byte header, then the record)
function encrypt(plaintext, uaPublic, authSecret, opts = {}) {
    const plain = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(String(plaintext), 'utf8');
    if (plain.length > MAX_PLAIN) throw new Error('push payload too big');
    const ua = Buffer.from(uaPublic), auth = Buffer.from(authSecret);
    if (ua.length !== 65 || ua[0] !== 4) throw new Error('bad p256dh');
    if (auth.length !== 16) throw new Error('bad auth secret');
    const ecdh = nodeCrypto.createECDH('prime256v1');
    if (opts.asPrivate) ecdh.setPrivateKey(Buffer.from(opts.asPrivate));
    else ecdh.generateKeys();
    const asPublic = ecdh.getPublicKey();
    const salt = opts.salt ? Buffer.from(opts.salt) : nodeCrypto.randomBytes(16);
    if (salt.length !== 16) throw new Error('bad salt');
    const secret = ecdh.computeSecret(ua);
    const { cek, nonce } = derive(secret, auth, ua, asPublic, salt);
    const cipher = nodeCrypto.createCipheriv('aes-128-gcm', cek, nonce);
    const body = Buffer.concat([cipher.update(Buffer.concat([plain, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
    const header = Buffer.alloc(21);
    salt.copy(header, 0);
    header.writeUInt32BE(RS, 16);
    header.writeUInt8(asPublic.length, 20);
    return Buffer.concat([header, asPublic, body]);
}

// The key schedule both ends share (one HKDF block each, so HMAC is enough).
function derive(ecdhSecret, auth, uaPublic, asPublic, salt) {
    const prkKey = hmac(auth, ecdhSecret);
    const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0', 'latin1'), uaPublic, asPublic, Buffer.from([1])]);
    const ikm = hmac(prkKey, keyInfo);
    const prk = hmac(salt, ikm);
    const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01', 'latin1')).subarray(0, 16);
    const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01', 'latin1')).subarray(0, 12);
    return { cek, nonce, ikm, prk };
}

// The browser's side, for the tests: body -> plaintext Buffer (throws if the
// tag doesn't check out).
function decrypt(body, uaPrivate, authSecret) {
    const buf = Buffer.from(body);
    const salt = buf.subarray(0, 16), idlen = buf.readUInt8(20);
    const asPublic = buf.subarray(21, 21 + idlen), rec = buf.subarray(21 + idlen);
    const ecdh = nodeCrypto.createECDH('prime256v1');
    ecdh.setPrivateKey(Buffer.from(uaPrivate));
    const ua = ecdh.getPublicKey();
    const { cek, nonce } = derive(ecdh.computeSecret(asPublic), Buffer.from(authSecret), ua, asPublic, salt);
    const d = nodeCrypto.createDecipheriv('aes-128-gcm', cek, nonce);
    d.setAuthTag(rec.subarray(rec.length - 16));
    const out = Buffer.concat([d.update(rec.subarray(0, rec.length - 16)), d.final()]);
    let end = out.length - 1;
    while (end >= 0 && out[end] === 0) end--;
    if (end < 0 || out[end] !== 2) throw new Error('bad padding');
    return out.subarray(0, end);
}

// ── VAPID (RFC 8292) ────────────────────────────────────────────────────
// One signed token per push service origin, reused until close to expiry.
const jwtCache = new Map();   // aud -> {token, exp}
function vapidToken(aud, nowMs = Date.now(), k = keys()) {
    if (!k) return null;
    const now = Math.floor(nowMs / 1000);
    const hit = jwtCache.get(aud);
    if (hit && hit.key === k.pubB64 && hit.exp - now > 60 * 60) return hit.token;
    const exp = now + JWT_TTL_S;
    const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
    const claims = b64u(JSON.stringify({ aud, exp, sub: config.webPush.subject }));
    const sig = nodeCrypto.sign('sha256', Buffer.from(head + '.' + claims), { key: k.key, dsaEncoding: 'ieee-p1363' });
    const token = head + '.' + claims + '.' + b64u(sig);
    if (jwtCache.size > 50) jwtCache.clear();
    jwtCache.set(aud, { token, exp, key: k.pubB64 });
    return token;
}

// ── sending ─────────────────────────────────────────────────────────────
let fetchImpl = (...a) => fetch(...a);
function setFetchForTests(fn) { fetchImpl = fn || ((...a) => fetch(...a)); jwtCache.clear(); }

// sub: {endpoint, p256dh, auth} (base64url). payload: an object (sent as
// JSON). opts: {ttl (s), urgency, topic}. -> {status, retryAfter (s) | 0}
// status 0 is a network failure or timeout. Never throws.
async function send(sub, payload, opts = {}) {
    const k = keys();
    if (!k) return { status: 0, retryAfter: 0, error: 'no keys' };
    let body, aud;
    try {
        aud = new URL(sub.endpoint).origin;
        body = encrypt(JSON.stringify(payload), unb64u(sub.p256dh), unb64u(sub.auth));
    } catch (e) {
        return { status: 400, retryAfter: 0, error: 'bad subscription' };
    }
    const headers = {
        'Content-Type': 'application/octet-stream',
        'Content-Encoding': 'aes128gcm',
        'Content-Length': String(body.length),
        TTL: String(Math.max(0, Math.floor(opts.ttl != null ? opts.ttl : 3600))),
        Urgency: opts.urgency || 'normal',
        Authorization: 'vapid t=' + vapidToken(aud) + ', k=' + k.pubB64,
    };
    if (opts.topic && /^[A-Za-z0-9_-]{1,32}$/.test(opts.topic)) headers.Topic = opts.topic;
    try {
        const res = await fetchImpl(sub.endpoint, { method: 'POST', headers, body, redirect: 'error', signal: AbortSignal.timeout(SEND_TIMEOUT_MS) });
        const ra = parseInt(res.headers && res.headers.get ? res.headers.get('retry-after') : '', 10);
        try { if (res.body && res.body.cancel) await res.body.cancel(); } catch (e) { /* nothing to read */ }
        return { status: res.status | 0, retryAfter: Number.isFinite(ra) && ra > 0 ? ra : 0 };
    } catch (e) {
        return { status: 0, retryAfter: 0, error: (e && e.name) || 'network' };
    }
}

module.exports = {
    RS, MAX_PLAIN, b64u, unb64u, parseKeys, keys, keyError, publicKey, generateKeys,
    encrypt, decrypt, derive, vapidToken, send, setFetchForTests,
};
