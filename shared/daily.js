// The daily rewards track: the table and the clock rules, shared by the
// server (require, server/accounts/retention.js decides and pays) and the
// client (<script> served at /shared/daily.js, exposes window.DWDaily, only
// for drawing and counting down). Nothing the client does here can pay
// anything: every claim is checked again on the server.
//
// The clock is the player's own, not midnight UTC. A claim unlocks the next
// day 20 hours later ("same time tomorrow", with 4 hours of slack, so an
// evening player can come back a bit earlier the next day). It stays
// claimable until 48 hours after the last claim; miss that and the track
// drops back DROP_BACK days (day 5 -> day 3 next), never to zero. A UTC reset
// would hand a US evening player day 1 and day 2 an hour apart (5 PM PT is
// midnight UTC) and drop EU players at 1 or 2 AM, which kills the "come
// back tomorrow" pull.
//
// Rewards: gemdust only, the lobby currency (Store and Locker on the menu)
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.DWDaily = api;
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const HOUR = 3600000;
    const UNLOCK_MS = 20 * HOUR;
    const GRACE_MS = 48 * HOUR;
    const DROP_BACK = 2;
    const DAYS = 7;

    // dustMilli is gemdust in thousandths (1000 = 1 dust). item 'day7' is the
    // first of DAY7_ITEMS the account doesn't have yet.
    // Very low on purpose, sized against the lobby shop: the cheapest shelf items are
    const TRACK = Object.freeze([
        Object.freeze({ day: 1, dustMilli: 1000 }),
        Object.freeze({ day: 2, dustMilli: 1500 }),
        Object.freeze({ day: 3, dustMilli: 0, item: 'sd_buddy', fallbackMilli: 2500 }),
        Object.freeze({ day: 4, dustMilli: 2000 }),
        Object.freeze({ day: 5, dustMilli: 2500 }),
        Object.freeze({ day: 6, dustMilli: 3000 }),
        Object.freeze({ day: 7, dustMilli: 0, item: 'day7', fallbackMilli: 4000 }),
    ]);
    // common sidekick skins only (the uncommon and rare ones stay in the shop)
    const DAY7_ITEMS = Object.freeze(['sds_stripes', 'sds_dots', 'sds_twotone']);
    // a full week of dust with every item already owned (the most a week pays in dust
    const WEEK_DUST_MILLI = TRACK.reduce((s, e) => s + e.dustMilli + (e.fallbackMilli | 0), 0);

    // Where a track stands at `now`. st: {step, streak, claims, lastClaimAt}
    // (a missing or never-claimed track is day 1, ready).
    // -> {day, ready, readyAt, expiresAt, missed, streak, from}
    //    day        the day the next claim pays (1..7)
    //    readyAt    when it unlocks (now or earlier when ready)
    //    expiresAt  after this the track drops back (null before the first claim)
    //    missed     the window was missed: day is already the dropped-back one
    //    streak     claims in a row the next claim continues (0 after a miss)
    //    from       the day it would have been without the miss
    function evaluate(st, now) {
        const claims = st ? st.claims | 0 : 0;
        if (!claims || st.lastClaimAt == null) {
            return { day: 1, ready: true, readyAt: now, expiresAt: null, missed: false, streak: 0, from: 1 };
        }
        const last = +st.lastClaimAt;
        const base = (st.step | 0) >= DAYS ? 0 : Math.max(0, st.step | 0);
        const readyAt = last + UNLOCK_MS, expiresAt = last + GRACE_MS;
        if (now < readyAt) return { day: base + 1, ready: false, readyAt, expiresAt, missed: false, streak: st.streak | 0, from: base + 1 };
        if (now <= expiresAt) return { day: base + 1, ready: true, readyAt, expiresAt, missed: false, streak: st.streak | 0, from: base + 1 };
        const dropped = Math.max(0, base - DROP_BACK);
        return { day: dropped + 1, ready: true, readyAt, expiresAt, missed: true, streak: 0, from: base + 1 };
    }

    // The track after claiming what evaluate() said, at `now`.
    // -> {step, streak, best, claims, lastClaimAt}
    function afterClaim(st, ev, now) {
        const streak = (ev.streak | 0) + 1;
        return {
            step: ev.day,
            streak,
            best: Math.max(st ? st.best | 0 : 0, streak),
            claims: (st ? st.claims | 0 : 0) + 1,
            lastClaimAt: now,
        };
    }

    // What the day after a claim of `day` is (the preview after claiming).
    const nextDay = (day) => (day >= DAYS ? 1 : day + 1);

    // "14h 32m", "32m", "45s"; "now" at or past zero.
    function countdown(ms) {
        if (!(ms > 0)) return 'now';
        const s = Math.ceil(ms / 1000);
        if (s < 60) return s + 's';
        const m = Math.ceil(s / 60);
        if (m < 60) return m + 'm';
        const h = Math.floor(m / 60), mm = m % 60;
        if (h < 48) return h + 'h ' + (mm < 10 ? '0' : '') + mm + 'm';
        return Math.floor(h / 24) + 'd ' + (h % 24) + 'h';
    }

    // ms until `at` on the server's clock, from the client's clock and the
    // skew measured when the status came back (serverNow - clientNow).
    function leftMs(at, clientNow, skew) {
        return Math.max(0, (+at || 0) - ((+clientNow || 0) + (+skew || 0)));
    }

    // The usual time of day someone shows up, as a UTC minute (0..1439):
    // each visit pulls the old value 30% of the way toward the new one, the
    // short way round midnight.
    function smoothMinute(old, cur) {
        cur = ((Math.round(cur) % 1440) + 1440) % 1440;
        if (old == null || !(old >= 0)) return cur;
        let d = cur - old;
        if (d > 720) d -= 1440;
        if (d <= -720) d += 1440;
        return ((Math.round(old + d * 0.3) % 1440) + 1440) % 1440;
    }
    const minuteOf = (ms) => Math.floor((((+ms % 86400000) + 86400000) % 86400000) / 60000);

    // When to send the "reward ready" ping: the first time at or after the
    // unlock that matches the player's usual minute of the day. Always lands
    // inside the claim window (at most 24 h after the unlock, which is 44 h
    // after the claim, 4 h before the drop).
    function pingAt(lastClaimAt, playMin) {
        const readyAt = +lastClaimAt + UNLOCK_MS;
        const want = playMin == null ? minuteOf(lastClaimAt) : playMin;
        let t = Math.floor(readyAt / 86400000) * 86400000 + want * 60000;
        if (t < readyAt) t += 86400000;
        return t;
    }

    return Object.freeze({
        HOUR, UNLOCK_MS, GRACE_MS, DROP_BACK, DAYS, TRACK, DAY7_ITEMS, WEEK_DUST_MILLI,
        evaluate, afterClaim, nextDay, countdown, leftMs, smoothMinute, minuteOf, pingAt,
    });
});
