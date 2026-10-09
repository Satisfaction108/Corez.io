// Web push: who asked for pings, and when to send them (push_subs, schema
// v12). The wire side (encryption, VAPID, the POST) is webpush.js.
//
// On when WEB_PUSH isn't 0 and the VAPID keys are set and valid. A player
// opts in from the menu after their first raid (client/account/retention.js);
// the browser's subscription is stored against their account, or their guest
// id, and sent again on later visits (that is "seen", and keeps it fresh).
//
// Two pings, nothing else:
//   daily   "your Day N reward is ready", once per claim (daily_for), at most
//           once in 20 h per subscription, at the player's usual time of day
//           (shared/daily.js pingAt), only while the reward is claimable and
//           only if they haven't been back since it unlocked. A player who
//           lapses gets that one ping and no more daily ones.
//   events  "Raid Night in 30 minutes" (shared/events.js), once per event,
//           sent 35 to 5 minutes before it starts, to anyone seen in the
//           last 60 days.
//
// Delivery: a tick every 30 s on the main thread, at most SEND_PER_TICK sends
// (SEND_PARALLEL at a time). A 404 / 410 from the push service means the
// subscription is gone: the row is deleted. 401 / 403 means it isn't ours to
// use (another VAPID key): deleted too. 429, 5xx and network errors back off
// (Retry-After when given, else 2^fails minutes, up to 12 h); MAX_FAILS in a
// row deletes it. Endpoints must be https on a known push service, so a
// made-up subscription can't point the server at anything else.
'use strict';

const db = require('./db');
const config = require('./config');
const webpush = require('./webpush');
const retention = require('./retention');
const D = require('../../shared/daily.js');
const E = require('../../shared/events.js');

const MIN = 60 * 1000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const TICK_MS = 30 * 1000;
const SEND_PER_TICK = 40;
const SEND_PARALLEL = 6;
const MAX_PER_OWNER = 4;
const MAX_FAILS = 6;
const DAILY_GAP_MS = 20 * HOUR;
const EVENT_LEAD_MS = 35 * MIN;
const EVENT_LATEST_MS = 5 * MIN;
const EVENT_SEEN_MS = 60 * DAY;
const GUEST_RE = /^[a-f0-9]{32}$/;

// The push services browsers use. Anything else is refused.
const HOSTS = [/^fcm\.googleapis\.com$/, /^([a-z0-9-]+\.)*push\.services\.mozilla\.com$/, /^([a-z0-9-]+\.)*push\.apple\.com$/,
    /^([a-z0-9-]+\.)*notify\.windows\.com$/];

function h() { return db.handle(); }
function enabled() {
    return !!(config.webPush && config.webPush.flag && webpush.keys() && h());
}

// {endpoint, keys:{p256dh, auth}} as the browser hands it over -> the clean
// row values, or null.
function cleanSub(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const endpoint = typeof raw.endpoint === 'string' ? raw.endpoint.trim() : '';
    if (endpoint.length < 20 || endpoint.length > 1024) return null;
    let u;
    try { u = new URL(endpoint); } catch (e) { return null; }
    if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) return null;
    if (!HOSTS.some(re => re.test(u.hostname.toLowerCase()))) return null;
    const k = raw.keys || {};
    const p = webpush.unb64u(k.p256dh), a = webpush.unb64u(k.auth);
    if (!p || p.length !== 65 || p[0] !== 4 || !a || a.length !== 16) return null;
    return { endpoint: u.href, p256dh: webpush.b64u(p), auth: webpush.b64u(a) };
}

// owner: {kind:'a'|'g', id}. topics: {daily, events} (both on by default).
// -> {ok:true, id} | {ok:false, code}
function subscribe(owner, raw, topics = {}, now = Date.now()) {
    const d = h();
    if (!d) return { ok: false, code: 'unavailable' };
    const s = cleanSub(raw);
    if (!s) return { ok: false, code: 'bad_subscription' };
    const uid = owner.kind === 'a' ? owner.id : null, gid = owner.kind === 'g' && GUEST_RE.test(owner.id) ? owner.id : null;
    if (!uid && !gid) return { ok: false, code: 'no_owner' };
    const daily = topics.daily === false ? 0 : 1, events = topics.events === false ? 0 : 1;
    return d.tx(() => {
        // the same browser again (maybe logged in now): it moves to this owner
        d.run(`INSERT INTO push_subs (endpoint, p256dh, auth, user_id, guest_id, daily, events, created_at, seen_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, user_id = excluded.user_id,
                   guest_id = excluded.guest_id, daily = excluded.daily, events = excluded.events, seen_at = excluded.seen_at,
                   fails = 0, retry_at = 0`,
            s.endpoint, s.p256dh, s.auth, uid, gid, daily, events, now, now);
        const id = d.get('SELECT id FROM push_subs WHERE endpoint = ?', s.endpoint).id;
        // a handful of devices per player; the oldest go
        const mine = uid ? d.all('SELECT id FROM push_subs WHERE user_id = ? ORDER BY seen_at DESC, id DESC', uid)
            : d.all('SELECT id FROM push_subs WHERE guest_id = ? ORDER BY seen_at DESC, id DESC', gid);
        for (const r of mine.slice(MAX_PER_OWNER)) d.run('DELETE FROM push_subs WHERE id = ?', r.id);
        return { ok: true, id };
    });
}

// -> true if there was one
function unsubscribe(endpoint) {
    const d = h();
    if (!d || typeof endpoint !== 'string' || endpoint.length > 1024) return false;
    let href = endpoint.trim();
    try { href = new URL(href).href; } catch (e) { /* matched as given */ }
    return d.run('DELETE FROM push_subs WHERE endpoint = ? OR endpoint = ?', href, endpoint.trim()).changes > 0;
}

function countFor(owner) {
    const d = h();
    if (!d) return 0;
    return owner.kind === 'a' ? d.get('SELECT count(*) AS n FROM push_subs WHERE user_id = ?', owner.id).n | 0
        : d.get('SELECT count(*) AS n FROM push_subs WHERE guest_id = ?', owner.id).n | 0;
}

// ── what is due ────────────────────────────────────────────────────────
// Pure. sub: {daily, daily_for, daily_at, retry_at}; tr: the daily_track row
// (or null). -> the time the ping is due, or 0 when nothing is owed.
function dailyDueAt(sub, tr, now) {
    if (!sub.daily || !tr || tr.adopted_by || !(tr.claims > 0) || tr.last_claim_at == null) return 0;
    if ((sub.daily_for | 0) >= tr.claims) return 0;                         // already pinged for this claim
    if (now - (sub.daily_at || 0) < DAILY_GAP_MS) return 0;
    const ev = D.evaluate({ step: tr.step, streak: tr.streak, claims: tr.claims, lastClaimAt: tr.last_claim_at }, now);
    if (!ev.ready || ev.missed) return 0;                                     // not yet, or the window is gone
    if (tr.seen_at != null && tr.seen_at >= ev.readyAt) return 0;             // they came back by themselves
    const at = D.pingAt(tr.last_claim_at, tr.play_min);
    return now >= at ? at : 0;
}

// Pure: the event to remind about at `now`, or null.
function eventDue(now) {
    const c = E.current(now);
    if (!c || c.live || c.ms > EVENT_LEAD_MS || c.ms < EVENT_LATEST_MS) return null;
    return c.ev;
}

function trackFor(d, sub) {
    return sub.user_id != null ? d.get('SELECT * FROM daily_track WHERE user_id = ?', sub.user_id)
        : d.get('SELECT * FROM daily_track WHERE guest_id = ?', sub.guest_id);
}

const dustText = (milli) => +((milli | 0) / 1000).toFixed(2) + ' gemdust';
function dailyPayload(sub, tr, now) {
    const owner = sub.user_id != null ? { kind: 'a', id: sub.user_id } : { kind: 'g', id: sub.guest_id };
    const st = retention.status(owner, now);
    const r = st.today;
    // "2.5 gemdust for the shop is waiting.", "A free Buddy sidekick is waiting."
    const what = r.item ? 'A free ' + r.item.name + (r.item.cat === 'sidekick' ? ' sidekick' : r.item.cat === 'sdSkin' ? ' skin' : '')
        : dustText(r.dustMilli) + ' for the shop';
    const streak = st.streak >= 2 ? ' Your ' + st.streak + '-day streak is still alive.' : '';
    return {
        kind: 'daily',
        title: 'Day ' + st.day + ' reward is ready',
        body: what + (r.signup ? ' is waiting for you. Sign up to keep it.' : ' is waiting for you.') + streak,
        tag: 'dw-daily',
        url: '/?from=push-daily',
    };
}
function eventPayload(ev) {
    return {
        kind: 'event',
        title: ev.name + ' in 30 minutes',
        body: 'Everyone plays in one big raid, with prizes for the top spots.',
        tag: 'dw-event-' + ev.id,
        url: '/?from=push-event',
    };
}

// ── sending ────────────────────────────────────────────────────────────
let busy = false, timer = null, lastLog = 0, cursor = 0;
const SCAN_PER_TICK = 400;
const inFlight = new Set();

function logOnce(msg) {
    const t = Date.now();
    if (t - lastLog < 10 * MIN) return;
    lastLog = t;
    console.error('[push] ' + msg);
}

// The push service's answer -> what happens to the row.
function settle(d, sub, r, now, ok) {
    if (r.status >= 200 && r.status < 300) {
        ok();
        d.run('UPDATE push_subs SET sent_at = ?, fails = 0, retry_at = 0 WHERE id = ?', now, sub.id);
        return 'sent';
    }
    if (r.status === 404 || r.status === 410 || r.status === 401 || r.status === 403) {
        d.run('DELETE FROM push_subs WHERE id = ?', sub.id);
        return 'gone';
    }
    const fails = (sub.fails | 0) + 1;
    if (fails >= MAX_FAILS) {
        d.run('DELETE FROM push_subs WHERE id = ?', sub.id);
        return 'gone';
    }
    const wait = r.retryAfter > 0 ? Math.min(12 * HOUR, r.retryAfter * 1000) : Math.min(12 * HOUR, Math.pow(2, fails) * MIN);
    d.run('UPDATE push_subs SET fails = ?, retry_at = ? WHERE id = ?', fails, now + wait, sub.id);
    if (r.status === 0 || r.status >= 500 || r.status === 429) return 'retry';
    logOnce('push service said ' + r.status + ' for ' + new URL(sub.endpoint).host);
    return 'retry';
}

// One pass. -> {daily, event, sent, gone, retry}
async function tick(now = Date.now()) {
    const out = { daily: 0, event: 0, sent: 0, gone: 0, retry: 0 };
    if (!enabled() || busy) return out;
    busy = true;
    const wall = Date.now();
    try {
        const d = h();
        const jobs = [];
        // Raid Night first: it can't wait, a daily ping can
        const ev = eventDue(now);
        if (ev) {
            const rows = d.all(`SELECT * FROM push_subs WHERE events = 1 AND retry_at <= ? AND seen_at >= ?
                                AND (last_event IS NULL OR last_event <> ?) ORDER BY seen_at DESC LIMIT ?`,
                now, now - EVENT_SEEN_MS, ev.id, SEND_PER_TICK);
            for (const s of rows) {
                if (inFlight.has(s.id)) continue;
                jobs.push({ sub: s, payload: eventPayload(ev), opts: { ttl: Math.max(60, Math.floor((ev.startMs - now) / 1000)), urgency: 'high', topic: 'raidnight' },
                    ok: () => d.run('UPDATE push_subs SET last_event = ? WHERE id = ?', ev.id, s.id), kind: 'event' });
            }
        }
        if (jobs.length < SEND_PER_TICK && retention.on()) {
            // a slice of the table per tick, round and round, so a big table
            // is still all looked at every few minutes
            let rows = d.all('SELECT * FROM push_subs WHERE id > ? AND daily = 1 AND retry_at <= ? AND daily_at <= ? ORDER BY id LIMIT ?',
                cursor, now, now - DAILY_GAP_MS, SCAN_PER_TICK);
            cursor = rows.length < SCAN_PER_TICK ? 0 : rows[rows.length - 1].id;
            for (const s of rows) {
                if (jobs.length >= SEND_PER_TICK) break;
                if (inFlight.has(s.id) || jobs.some(j => j.sub.id === s.id)) continue;
                const tr = trackFor(d, s);
                if (!dailyDueAt(s, tr, now)) continue;
                let payload;
                try { payload = dailyPayload(s, tr, now); } catch (e) { continue; }
                const claims = tr.claims;
                jobs.push({ sub: s, payload, opts: { ttl: 6 * 60 * 60, urgency: 'normal', topic: 'daily' },
                    ok: () => d.run('UPDATE push_subs SET daily_for = ?, daily_at = ? WHERE id = ?', claims, now, s.id), kind: 'daily' });
            }
        }
        for (let i = 0; i < jobs.length; i += SEND_PARALLEL) {
            const batch = jobs.slice(i, i + SEND_PARALLEL);
            batch.forEach(j => inFlight.add(j.sub.id));
            const results = await Promise.all(batch.map(j => webpush.send(j.sub, j.payload, j.opts)));
            const t = now + (Date.now() - wall);
            batch.forEach((j, k) => {
                inFlight.delete(j.sub.id);
                try {
                    const what = settle(d, j.sub, results[k], t, j.ok);
                    out[what]++;
                    if (what === 'sent') out[j.kind]++;
                } catch (e) { logOnce('settle failed: ' + ((e && e.message) || e)); }
            });
        }
    } catch (e) {
        logOnce('tick failed: ' + ((e && e.stack) || e));
    } finally {
        busy = false;
    }
    return out;
}

function start() {
    if (timer) return;
    if (config.webPush && config.webPush.flag && !webpush.keys()) {
        const why = webpush.keyError();
        if (why) console.error('[push] ' + why + '; web push is off');
    }
    timer = setInterval(() => { tick().catch(() => { /* logged inside */ }); }, TICK_MS);
    if (timer.unref) timer.unref();
}
function stop() {
    if (timer) clearInterval(timer);
    timer = null;
}
// Tests only.
function reset() { busy = false; cursor = 0; inFlight.clear(); lastLog = 0; }

module.exports = {
    TICK_MS, SEND_PER_TICK, MAX_PER_OWNER, MAX_FAILS, DAILY_GAP_MS, EVENT_LEAD_MS, EVENT_LATEST_MS,
    enabled, cleanSub, subscribe, unsubscribe, countFor, dailyDueAt, eventDue, dailyPayload, eventPayload, tick, start, stop, reset,
};
