// In-memory rate limits (single process, so no shared store is needed).
//
// Two kinds:
// - sliding windows: at most `limit` events per `windowMs` per key;
// - failure backoff: after `free` failures inside `windowMs`, each further
//   attempt must wait base * 2^(extra failures), capped at maxMs.
// A 60 s sweep (unref'd) forgets idle keys.
//
// Slow attempts (anything that runs scrypt) are charged with take() before
// the work starts and refunded if they turn out not to count, so a burst of
// parallel requests cannot all pass the check while the first ones are
// still in flight. Client addresses go through ipKey() first.
'use strict';

const net = require('net');

const MIN = 60 * 1000;

const WINDOWS = {
    loginFail:     { limit: 5,   windowMs: 15 * MIN },  // per IP + username
    loginIpFail:   { limit: 30,  windowMs: 15 * MIN },  // per IP, any username (password spraying)
    signup:        { limit: 12,  windowMs: 60 * MIN },  // accounts created per IP (schools share one)
    signupTry:     { limit: 60,  windowMs: 60 * MIN },  // signup attempts per IP
    recoverFail:   { limit: 5,   windowMs: 15 * MIN },  // per IP
    recoverUser:   { limit: 5,   windowMs: 60 * MIN },  // per username
    reset:         { limit: 10,  windowMs: 15 * MIN },  // per IP
    discordStart:  { limit: 20,  windowMs: 10 * MIN },  // per IP
    discordCallback: { limit: 20, windowMs: 10 * MIN }, // per IP
    discordDone:   { limit: 10,  windowMs: 15 * MIN },  // pick-username submits per IP
    nameCheck:     { limit: 60,  windowMs: 1 * MIN },   // username-available per IP
    passwordFail:  { limit: 5,   windowMs: 15 * MIN },  // current-password checks per account
    accountWrite:  { limit: 30,  windowMs: 10 * MIN },  // account setting changes per account
    api:           { limit: 240, windowMs: 1 * MIN },   // every /api request per IP, and per session too
    purchase:      { limit: 10,  windowMs: 1 * MIN },   // store purchases + gifts + refunds per account
    equip:         { limit: 60,  windowMs: 1 * MIN },   // locker equips per account
    friendRequest: { limit: 20,  windowMs: 60 * MIN },  // friend requests sent per account
    social:        { limit: 60,  windowMs: 10 * MIN },  // blocks + unblocks per account
    dm:            { limit: 20,  windowMs: 1 * MIN },   // friend chat messages sent per account
    dmBurst:       { limit: 5,   windowMs: 5 * 1000 },  // ...and no more than 5 in any 5 s
    dmRead:        { limit: 120, windowMs: 1 * MIN },   // read receipts per account
};

const BACKOFFS = {
    // Per username, across all IPs: 10 free failures an hour, then 30 s, 1 m,
    // 2 m ... up to 15 m between attempts. Success clears it. Skipped for a
    // browser the account has logged in from before (the dw_dev cookie).
    loginUser: { free: 10, windowMs: 60 * MIN, baseMs: 30 * 1000, maxMs: 15 * MIN },
};

const windows = new Map();   // "bucket\0key" -> [timestamps]
const backoffs = new Map();  // "bucket\0key" -> {fails:[timestamps], last}
let timer = null;

function k(bucket, key) {
    return bucket + '\0' + String(key).toLowerCase();
}

// "::" compression and a dotted IPv4 tail expanded -> 8 numbers.
function ipv6Groups(a) {
    const dotted = /^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(a);
    if (dotted) {
        const b = dotted.slice(2).map(Number);
        a = dotted[1] + ((b[0] << 8) | b[1]).toString(16) + ':' + ((b[2] << 8) | b[3]).toString(16);
    }
    const gap = a.indexOf('::');
    const head = (gap < 0 ? a : a.slice(0, gap)).split(':').filter(Boolean);
    const tail = gap < 0 ? [] : a.slice(gap + 2).split(':').filter(Boolean);
    const fill = gap < 0 ? [] : new Array(8 - head.length - tail.length).fill('0');
    return [...head, ...fill, ...tail].map(g => parseInt(g, 16));
}

// The rate-limit key for a client address: IPv4 as is (also when it arrives
// IPv4-mapped, ::ffff:1.2.3.4), IPv6 by its /64, since a single home or
// server usually holds a whole /64 and could use a new address per request.
function ipKey(ip) {
    let a = String(ip == null ? '' : ip).trim();
    if (a.startsWith('[') && a.indexOf(']') > 0) a = a.slice(1, a.indexOf(']'));
    const zone = a.indexOf('%');
    if (zone >= 0) a = a.slice(0, zone);
    if (!net.isIPv6(a)) return a;
    const g = ipv6Groups(a);
    if (g.length !== 8 || g.some(x => !(x >= 0 && x <= 0xffff))) return a.toLowerCase();
    if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0xffff) {
        return [g[6] >> 8, g[6] & 255, g[7] >> 8, g[7] & 255].join('.');
    }
    return g.slice(0, 4).map(x => x.toString(16)).join(':') + '::/64';
}

function prune(list, windowMs, now) {
    let i = 0;
    while (i < list.length && list[i] <= now - windowMs) i++;
    if (i) list.splice(0, i);
    return list;
}

// -> {ok:true} | {ok:false, retryAfter (seconds)}. Does not record anything.
function check(bucket, key, now = Date.now()) {
    const spec = WINDOWS[bucket];
    if (!spec) throw new Error('unknown rate-limit bucket ' + bucket);
    const list = windows.get(k(bucket, key));
    if (!list) return { ok: true };
    prune(list, spec.windowMs, now);
    if (list.length < spec.limit) return { ok: true };
    return { ok: false, retryAfter: Math.max(1, Math.ceil((list[0] + spec.windowMs - now) / 1000)) };
}

function record(bucket, key, now) {
    const id = k(bucket, key);
    let list = windows.get(id);
    if (!list) windows.set(id, list = []);
    list.push(now);
}

// Records one event, then reports whether it was within the limit.
function hit(bucket, key, now = Date.now()) {
    const r = check(bucket, key, now);
    if (!r.ok) return r;
    record(bucket, key, now);
    return { ok: true };
}

// Takes back one event recorded at `at`.
function refund(bucket, key, at) {
    const id = k(bucket, key);
    const list = windows.get(id);
    if (!list) return;
    const i = list.lastIndexOf(at);
    if (i >= 0) list.splice(i, 1);
    if (!list.length) windows.delete(id);
}

function clear(bucket, key) {
    windows.delete(k(bucket, key));
    backoffs.delete(k(bucket, key));
}

function backoffCheck(bucket, key, now = Date.now()) {
    const spec = BACKOFFS[bucket];
    const b = backoffs.get(k(bucket, key));
    if (!b) return { ok: true };
    prune(b.fails, spec.windowMs, now);
    const extra = b.fails.length - spec.free;
    if (extra < 0) return { ok: true };
    const wait = Math.min(spec.maxMs, spec.baseMs * Math.pow(2, extra));
    const until = b.last + wait;
    return until > now ? { ok: false, retryAfter: Math.max(1, Math.ceil((until - now) / 1000)) } : { ok: true };
}

function backoffFail(bucket, key, now = Date.now()) {
    const spec = BACKOFFS[bucket];
    const id = k(bucket, key);
    let b = backoffs.get(id);
    if (!b) backoffs.set(id, b = { fails: [], last: 0 });
    prune(b.fails, spec.windowMs, now);
    b.fails.push(now);
    b.last = now;
}

function backoffRefund(bucket, key, at) {
    const b = backoffs.get(k(bucket, key));
    if (!b) return;
    const i = b.fails.lastIndexOf(at);
    if (i >= 0) b.fails.splice(i, 1);
    b.last = b.fails.length ? b.fails[b.fails.length - 1] : 0;
}

// Charges an attempt up front: checks every [bucket, key] (a sliding window,
// or a failure backoff when the bucket is one), and only if all have room
// records one event in each. Falsy entries are skipped.
// -> {ok:true, refund()} | {ok:false, retryAfter}. refund() hands the events
// back, for an attempt that turned out not to count (it succeeded, or never ran).
function take(entries, now = Date.now()) {
    const list = entries.filter(Boolean);
    for (const [bucket, key] of list) {
        const r = BACKOFFS[bucket] ? backoffCheck(bucket, key, now) : check(bucket, key, now);
        if (!r.ok) return r;
    }
    for (const [bucket, key] of list) {
        if (BACKOFFS[bucket]) backoffFail(bucket, key, now);
        else record(bucket, key, now);
    }
    let refunded = false;
    return {
        ok: true,
        refund() {
            if (refunded) return;
            refunded = true;
            for (const [bucket, key] of list) {
                if (BACKOFFS[bucket]) backoffRefund(bucket, key, now);
                else refund(bucket, key, now);
            }
        },
    };
}

function sweep(now = Date.now()) {
    for (const [id, list] of windows) {
        const spec = WINDOWS[id.slice(0, id.indexOf('\0'))];
        if (!spec || !prune(list, spec.windowMs, now).length) windows.delete(id);
    }
    for (const [id, b] of backoffs) {
        const spec = BACKOFFS[id.slice(0, id.indexOf('\0'))];
        if (!spec || (!prune(b.fails, spec.windowMs, now).length && now - b.last > spec.maxMs)) backoffs.delete(id);
    }
}

function start() {
    if (timer) return;
    timer = setInterval(sweep, 60 * 1000);
    if (timer.unref) timer.unref();
}

function stop() {
    if (timer) clearInterval(timer);
    timer = null;
}

// Tests only.
function reset() {
    windows.clear();
    backoffs.clear();
}

module.exports = {
    WINDOWS, BACKOFFS, ipKey, check, hit, refund, take, clear, backoffCheck, backoffFail, backoffRefund, sweep, start, stop, reset,
};
