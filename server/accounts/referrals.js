// Invites: codes, referrals and their rewards (the database side).
//
// Every account has one stable 7-character Crockford code, made the first
// time it is asked for. A browser that opened /?ref=CODE sends the code with
// a sign-up (body.ref or the dw_ref cookie); recordSignup() then writes a
// referral row for the brand-new account. Existing accounts can never be
// referred: nothing else writes these rows.
//
// A referral stays pending until the new account has finished one real raid
// life (QUALIFY_*), then evaluate() decides it:
//   same_device   the sign-up browser carries the referrer's dw_dev cookie
//   same_network  any address the new account has used (sign-up, sessions,
//                 audit log) matches one the referrer has used
//   ip_used       another invite from that sign-up address already counted
//   expired       no qualifying life within PENDING_TTL_MS
// Addresses are compared as HMACs (ipHash) keyed from SESSION_SECRET, IPv6
// grouped by /64 like the rate limits.
//
// A counted invite pays REWARD_MILLI to the referrer (first PAID_MAX only,
// ledger kind 'referral'). At NAME_STYLE_AT counted invites the exclusive
// name style is granted (owned_items source 'grant'); at CUSTOM_SKIN_AT the
// custom skin is recorded for the admins (audit 'referral_skin_earned').
// referral_rewards has one row per milestone, so each is granted once.
//
// Evaluation runs on the main thread: when the game reports a settled life
// (bus 'lifeSettled'), when the referrer opens the invite panel, and on a
// sweep every SWEEP_MS.
'use strict';

const nodeCrypto = require('crypto');
const bus = require('./bus');
const config = require('./config');
const crypto = require('./crypto');
const db = require('./db');
const dust = require('./dust');
const ratelimit = require('./ratelimit');
const users = require('./users');
const C = require('../../shared/cosmetics.js');

const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;
const CODE_LEN = 7;
const CODE_RE = /^[0-9A-HJKMNP-TV-Z]{7}$/;
const REWARD_MILLI = 3000;
const PAID_MAX = 25;
const NAME_STYLE_AT = 3;
const CUSTOM_SKIN_AT = 5;
const NAME_STYLE_ID = C.INVITE_STYLE_ID;
const PENDING_TTL_MS = 30 * DAY;
const REF_COOKIE = 'dw_ref';
// a life counts once it lasted QUALIFY_MS, or QUALIFY_SCORED_MS with points
const QUALIFY_MS = 2 * MIN;
const QUALIFY_SCORED_MS = 30 * 1000;
const SWEEP_MS = 10 * MIN;
const SWEEP_BATCH = 200;
const RECENT_LIMIT = 10;

function h() { return db.handle(); }

// ---- codes ----

// "k7q2-mx9" -> "K7Q2MX9", or '' when it cannot be a code.
function normalizeCode(raw) {
    const s = crypto.crockfordNormalize(typeof raw === 'string' ? raw.slice(0, 32) : '');
    return CODE_RE.test(s) ? s : '';
}

// The account's code, made on first use. -> 'XXXXXXX' | null (no account)
function codeFor(userId, now = Date.now()) {
    const d = h();
    if (!d) return null;
    const have = d.get('SELECT code FROM invite_codes WHERE user_id = ?', userId);
    if (have) return have.code;
    if (!d.get('SELECT 1 AS x FROM users WHERE id = ? AND deleted_at IS NULL', userId)) return null;
    // a code taken by someone else inserts nothing: draw again
    for (let i = 0; i < 8; i++) {
        const code = crypto.crockfordEncode(nodeCrypto.randomBytes(5)).slice(0, CODE_LEN);
        d.run('INSERT INTO invite_codes (user_id, code, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING', userId, code, now);
        const row = d.get('SELECT code FROM invite_codes WHERE user_id = ?', userId);
        if (row) return row.code;
    }
    return null;
}

// -> live, unbanned user row | null
function ownerOf(code, now = Date.now()) {
    const d = h();
    const c = normalizeCode(code);
    if (!d || !c) return null;
    const row = d.get('SELECT u.* FROM invite_codes i JOIN users u ON u.id = i.user_id WHERE i.code = ? AND u.deleted_at IS NULL', c);
    return row && !users.isBanned(row, now) ? row : null;
}

function linkFor(code) {
    return code ? config.publicOrigin + '/?ref=' + code : null;
}

// ---- addresses ----

let ipKeyCache = null;
function ipSecret() {
    if (!ipKeyCache || ipKeyCache.secret !== config.sessionSecret) {
        ipKeyCache = {
            secret: config.sessionSecret,
            key: nodeCrypto.createHmac('sha256', config.sessionSecret || 'dev').update('invite-ip-v1').digest(),
        };
    }
    return ipKeyCache.key;
}

// Same /64 for IPv6, like the rate limits. -> 32 hex chars | null
function ipHash(ip) {
    const k = ratelimit.ipKey(ip);
    if (!k) return null;
    return nodeCrypto.createHmac('sha256', ipSecret()).update(k).digest('hex').slice(0, 32);
}

// Every address the account is known to have used, hashed: its sessions,
// its audit log (IPs are kept 90 days) and its own sign-up referral row.
function knownIpHashes(userId) {
    const d = h();
    const out = new Set();
    for (const r of d.all(`SELECT DISTINCT ip FROM sessions WHERE user_id = ? AND ip IS NOT NULL
                           UNION SELECT DISTINCT ip FROM audit_log WHERE user_id = ? AND ip IS NOT NULL`, userId, userId)) {
        const x = ipHash(r.ip);
        if (x) out.add(x);
    }
    const own = d.get('SELECT ip_hash FROM referrals WHERE referee_id = ?', userId);
    if (own) out.add(own.ip_hash);
    return out;
}

function overlaps(a, b) {
    for (const x of a) if (b.has(x)) return true;
    return false;
}

// ---- sign-up ----

// The code a sign-up request carries: the body wins over the cookie.
function codeFromRequest(ctx) {
    const body = ctx.body && typeof ctx.body.ref === 'string' ? ctx.body.ref : '';
    return normalizeCode(body) || normalizeCode(ctx.cookies[REF_COOKIE] || '');
}

// Right after users.create() for a brand-new account. Never throws.
// {user, method:'password'|'discord', code, ip, deviceUserId, now}
// -> {id, status, reason} | null (no code, unknown code, or not recorded)
function recordSignup(opts) {
    const d = h();
    if (!d || !opts || !opts.user || !opts.code) return null;
    const now = opts.now || Date.now();
    try {
        return d.tx(() => {
            const referee = d.get('SELECT id, created_at FROM users WHERE id = ? AND deleted_at IS NULL', opts.user.id);
            if (!referee) return null;
            // only an account created by this very request
            if (now - referee.created_at > 5 * MIN) return null;
            const referrer = ownerOf(opts.code, now);
            if (!referrer || referrer.id === referee.id) return null;
            const hash = ipHash(opts.ip);
            if (!hash) return null;
            let reason = null;
            if (opts.deviceUserId && opts.deviceUserId === referrer.id) reason = 'same_device';
            else if (knownIpHashes(referrer.id).has(hash)) reason = 'same_network';
            const status = reason ? 'rejected' : 'pending';
            const r = d.run(`INSERT INTO referrals (referrer_id, referee_id, code, method, status, reason, ip_hash, created_at, decided_at)
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(referee_id) DO NOTHING`,
                referrer.id, referee.id, normalizeCode(opts.code), opts.method === 'discord' ? 'discord' : 'password',
                status, reason, hash, now, reason ? now : null);
            if (!r.changes) return null;
            users.audit(referee.id, 'referral_signup', { referrer: referrer.public_id, status, reason }, { now, actor: 'system' });
            return { id: r.lastInsertRowid, referrerId: referrer.id, status, reason };
        });
    } catch (e) {
        console.error('[accounts] invite signup failed: ' + ((e && e.stack) || e));
        return null;
    }
}

// ---- qualifying ----

// The account is brand new, so every life it has is after the sign-up.
function hasQualifyingLife(userId) {
    return !!h().get(`SELECT 1 AS x FROM rank_lives WHERE user_id = ? AND ended_at IS NOT NULL
                          AND end_reason IN ('death', 'raid_end', 'disconnect')
                          AND (ended_at - started_at >= ? OR (basis > 0 AND ended_at - started_at >= ?)) LIMIT 1`,
        userId, QUALIFY_MS, QUALIFY_SCORED_MS);
}

function qualifiedCount(userId) {
    return h().get("SELECT count(*) AS n FROM referrals WHERE referrer_id = ? AND status = 'qualified'", userId).n | 0;
}

function reject(id, reason, now) {
    h().run("UPDATE referrals SET status = 'rejected', reason = ?, decided_at = ? WHERE id = ? AND status = 'pending'", reason, now, id);
}

// Milestone rewards up to `count` counted invites, each once. -> ['name_style', ...] newly granted
function grantMilestones(userId, count, now) {
    const d = h();
    const out = [];
    if (count >= NAME_STYLE_AT && d.run('INSERT INTO referral_rewards (user_id, tier, at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING', userId, 'name_style', now).changes) {
        d.run("INSERT INTO owned_items (user_id, item_id, source, acquired_at) VALUES (?, ?, 'grant', ?) ON CONFLICT DO NOTHING", userId, NAME_STYLE_ID, now);
        users.audit(userId, 'referral_name_style', { itemId: NAME_STYLE_ID, invites: count }, { now, actor: 'system' });
        out.push('name_style');
    }
    if (count >= CUSTOM_SKIN_AT && d.run('INSERT INTO referral_rewards (user_id, tier, at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING', userId, 'custom_skin', now).changes) {
        users.audit(userId, 'referral_skin_earned', { invites: count }, { now, actor: 'system' });
        out.push('custom_skin');
    }
    return out;
}

// Decides the pending referral of this new account, if it can be decided
// now. -> {status:'qualified', ...} | {status:'rejected', reason} | null (still pending / none)
function evaluate(refereeId, now = Date.now()) {
    const d = h();
    if (!d || !refereeId) return null;
    const ref = d.get("SELECT * FROM referrals WHERE referee_id = ? AND status = 'pending'", refereeId);
    if (!ref) return null;
    if (now - ref.created_at > PENDING_TTL_MS) { reject(ref.id, 'expired', now); return { status: 'rejected', reason: 'expired' }; }
    const referee = users.byId(refereeId);
    const referrer = users.byId(ref.referrer_id);
    if (!referee || !referrer || users.isBanned(referee, now) || users.isBanned(referrer, now)) return null;
    if (!hasQualifyingLife(refereeId)) return null;

    const res = d.tx(() => {
        const cur = d.get("SELECT * FROM referrals WHERE id = ? AND status = 'pending'", ref.id);
        if (!cur) return null;
        if (overlaps(knownIpHashes(refereeId), knownIpHashes(ref.referrer_id))) {
            reject(ref.id, 'same_network', now);
            return { status: 'rejected', reason: 'same_network' };
        }
        if (d.get("SELECT 1 AS x FROM referrals WHERE ip_hash = ? AND status = 'qualified' LIMIT 1", ref.ip_hash)) {
            reject(ref.id, 'ip_used', now);
            return { status: 'rejected', reason: 'ip_used' };
        }
        const paidBefore = d.get("SELECT count(*) AS n FROM referrals WHERE referrer_id = ? AND status = 'qualified' AND reward_milli > 0", ref.referrer_id).n | 0;
        const reward = paidBefore < PAID_MAX ? REWARD_MILLI : 0;
        d.run("UPDATE referrals SET status = 'qualified', reason = NULL, decided_at = ?, reward_milli = ? WHERE id = ? AND status = 'pending'",
            now, reward, ref.id);
        let balance = null;
        if (reward) balance = dust.creditExempt(ref.referrer_id, reward, 'referral', 'referral:' + ref.id, now);
        const count = qualifiedCount(ref.referrer_id);
        const granted = grantMilestones(ref.referrer_id, count, now);
        users.audit(ref.referrer_id, 'referral_qualified', { referralId: ref.id, referee: referee.public_id, rewardMilli: reward, invites: count }, { now, actor: 'system' });
        return { status: 'qualified', referralId: ref.id, referrerId: ref.referrer_id, rewardMilli: reward, balanceMilli: balance, count, granted };
    });
    if (res && res.status === 'qualified') notify(res, referee);
    return res;
}

function notify(res, referee) {
    if (res.rewardMilli) {
        try { bus.toGame({ t: 'dustChanged', userId: res.referrerId }); } catch (e) { /* game gone */ }
    }
    try {
        require('./routes/events').push(res.referrerId, 'invite', {
            username: referee.username, rewardMilli: res.rewardMilli, balanceMilli: res.balanceMilli, count: res.count, granted: res.granted,
        });
    } catch (e) { /* no stream */ }
}

// Checks every pending referral of this referrer (the invite panel opening).
function evaluateFor(referrerId, now = Date.now()) {
    const d = h();
    if (!d) return;
    for (const r of d.all("SELECT referee_id FROM referrals WHERE referrer_id = ? AND status = 'pending' AND referee_id IS NOT NULL LIMIT 50", referrerId)) {
        try { evaluate(r.referee_id, now); } catch (e) { console.error('[accounts] invite check failed: ' + ((e && e.stack) || e)); }
    }
}

// Pending referrals, oldest first: expire or decide them. -> number decided
function sweep(now = Date.now()) {
    const d = h();
    if (!d) return 0;
    let n = 0;
    d.run("UPDATE referrals SET status = 'rejected', reason = 'expired', decided_at = ? WHERE status = 'pending' AND (created_at < ? OR referee_id IS NULL)",
        now, now - PENDING_TTL_MS);
    for (const r of d.all("SELECT referee_id FROM referrals WHERE status = 'pending' ORDER BY created_at LIMIT ?", SWEEP_BATCH)) {
        try { if (evaluate(r.referee_id, now)) n++; } catch (e) { console.error('[accounts] invite sweep failed: ' + ((e && e.stack) || e)); }
    }
    return n;
}

// ---- views ----

// GET /api/invite, /invites. recent: newest first, generic reasons only.
function summary(userId, now = Date.now(), opts = {}) {
    const d = h();
    const code = opts.create === false
        ? ((d.get('SELECT code FROM invite_codes WHERE user_id = ?', userId) || {}).code || null)
        : codeFor(userId, now);
    const t = d.get(`SELECT COALESCE(SUM(status = 'qualified'), 0) AS qualified, COALESCE(SUM(status = 'pending'), 0) AS pending,
                            COALESCE(SUM(status = 'rejected'), 0) AS rejected, COALESCE(SUM(reward_milli), 0) AS earned
                     FROM referrals WHERE referrer_id = ?`, userId);
    const tiers = new Map(d.all('SELECT tier, at FROM referral_rewards WHERE user_id = ?', userId).map(r => [r.tier, r.at]));
    const recent = d.all(`SELECT r.status, r.reason, r.created_at, r.decided_at, u.username, u.public_id, u.deleted_at
                          FROM referrals r LEFT JOIN users u ON u.id = r.referee_id
                          WHERE r.referrer_id = ? ORDER BY r.created_at DESC, r.id DESC LIMIT ?`, userId, opts.limit || RECENT_LIMIT);
    const count = t.qualified | 0;
    return {
        code,
        link: linkFor(code),
        count,
        pending: t.pending | 0,
        rejected: t.rejected | 0,
        rewards: {
            perFriendMilli: REWARD_MILLI,
            paidMax: PAID_MAX,
            dustEarnedMilli: t.earned | 0,
            nameStyle: { itemId: NAME_STYLE_ID, need: NAME_STYLE_AT, unlocked: tiers.has('name_style'), at: tiers.get('name_style') || null },
            customSkin: { need: CUSTOM_SKIN_AT, unlocked: tiers.has('custom_skin'), at: tiers.get('custom_skin') || null },
        },
        recent: recent.map(r => ({
            username: r.username && r.deleted_at == null ? r.username : null,
            userId: r.public_id && r.deleted_at == null ? r.public_id : null,
            status: r.status,
            reason: r.status === 'rejected' ? (r.reason === 'expired' ? 'expired' : 'not_eligible') : null,
            at: r.created_at,
            decidedAt: r.decided_at,
        })),
    };
}

// ---- wiring ----

const state = { timer: null, unsub: null };

function start() {
    if (state.timer) return;
    state.timer = setInterval(() => { try { sweep(); } catch (e) { console.error('[accounts] invite sweep failed: ' + ((e && e.stack) || e)); } }, SWEEP_MS);
    if (state.timer.unref) state.timer.unref();
    state.unsub = bus.onMain((serverId, msg) => {
        if (!msg || msg.t !== 'lifeSettled' || !msg.userId) return;
        // off the game's call stack (single-process mode calls this inline)
        const id = msg.userId | 0;
        setImmediate(() => {
            try { evaluate(id); } catch (e) { console.error('[accounts] invite check failed: ' + ((e && e.stack) || e)); }
        });
    });
}

function stop() {
    if (state.timer) clearInterval(state.timer);
    state.timer = null;
    if (state.unsub) state.unsub();
    state.unsub = null;
}

module.exports = {
    CODE_LEN, REWARD_MILLI, PAID_MAX, NAME_STYLE_AT, CUSTOM_SKIN_AT, NAME_STYLE_ID, PENDING_TTL_MS, REF_COOKIE,
    QUALIFY_MS, QUALIFY_SCORED_MS,
    normalizeCode, codeFor, ownerOf, linkFor, ipHash, knownIpHashes, codeFromRequest,
    recordSignup, hasQualifyingLife, evaluate, evaluateFor, sweep, summary, start, stop,
};
