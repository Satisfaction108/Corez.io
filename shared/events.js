// The event schedule (Raid Night and friends), shared by the server
// (require) and the client (<script> served at /shared/events.js, exposes
// window.DWEvents). To add or move an event, edit EVENTS below: start is
// an ISO time in UTC, durationMin how long it runs. The menu card
// (client/account/eventCard.js) and the in-raid chip and callouts (app.js)
// always show the next upcoming or live one.
//
// Local testing only: on localhost, ?eventNow= fakes the clock, e.g.
//   ?eventNow=2026-10-04T02:50:00Z   an exact time
//   ?eventNow=start-10m               10 minutes before the next event
//   ?eventNow=start+5m                5 minutes into it (s, m, h, d)
// or DWEvents.fake('start-10m') from the console (fake('') resets it).
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.DWEvents = api;
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const EVENTS = [
        {
            id: 'raid-night-1',
            name: 'Raid Night',
            start: '2026-10-04T03:00:00Z',   // Sat Oct 3, 8:00 PM Pacific
            durationMin: 60,
            blurb: 'Everyone in one raid. Bring friends.',
            liveBlurb: 'Everyone is in one raid. Hit Play to jump in.',
        },
    ];

    const DISCORD = 'https://discord.gg/bx5FK3CMwp';
    const SITE = 'https://corez.io';
    const MENU_LEAD_MS = 14 * 86400000;   // the menu card shows up this far ahead
    const HUD_LEAD_MS = 24 * 3600000;     // the in-raid chip
    const SOON_MS = 10 * 60000;           // the "starts soon" callout

    const LIST = EVENTS.map((e) => {
        const startMs = Date.parse(e.start);
        return Object.freeze(Object.assign({}, e, { startMs, endMs: startMs + Math.max(1, +e.durationMin || 60) * 60000 }));
    }).filter((e) => Number.isFinite(e.startMs)).sort((a, b) => a.startMs - b.startMs);

    // dev clock: only on a local host, and only when asked for
    let skew = 0, local = false;
    function fake(want) {
        if (!local) return false;
        want = String(want || '').replace(/ /g, '+');   // a raw + in a query string reads back as a space
        const real = Date.now();
        let at = NaN;
        const m = /^start([+-]\d+(?:\.\d+)?)([smhd])$/.exec(want);
        if (m) {
            const e = LIST.find((x) => x.endMs > real) || LIST[LIST.length - 1];
            if (e) at = e.startMs + parseFloat(m[1]) * { s: 1e3, m: 6e4, h: 36e5, d: 864e5 }[m[2]];
        } else if (want) at = /^\d+$/.test(want) ? +want : Date.parse(want);
        skew = Number.isFinite(at) ? at - real : 0;
        return skew !== 0;
    }
    try {
        const loc = typeof location !== 'undefined' ? location : null;
        local = !!loc && /^(localhost|127\.0\.0\.1|\[::1\])$|\.localhost$|\.test$/.test(loc.hostname);
        if (local) fake(new URLSearchParams(loc.search).get('eventNow'));
    } catch (e) { /* no override */ }
    const now = () => Date.now() + skew;

    // The event to show at time t: the live one, else the next to start.
    // {ev, live, ms} where ms is the time to its start (or to its end if live).
    function current(t) {
        if (t == null) t = now();
        for (const e of LIST) {
            if (t >= e.endMs) continue;
            return t >= e.startMs ? { ev: e, live: true, ms: e.endMs - t } : { ev: e, live: false, ms: e.startMs - t };
        }
        return null;
    }

    // "2d 4h 13m", "4h 13m", then "12:34" in the last hour
    function countdown(ms) {
        const s = Math.max(0, Math.ceil(ms / 1000));
        if (s < 3600) {
            const mm = Math.floor(s / 60), ss = s % 60;
            return mm + ':' + (ss < 10 ? '0' : '') + ss;
        }
        const m = Math.floor(s / 60), d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mi = m % 60;
        return (d ? d + 'd ' : '') + h + 'h ' + mi + 'm';
    }

    // The start in the viewer's own time zone: "Sat 8:00 PM", with the date
    // when it is a week or more away, "Today" / "Tomorrow" when close.
    function localWhen(e, t) {
        if (t == null) t = now();
        const d = new Date(e.startMs);
        try {
            const time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(d);
            // calendar days apart, in local time (round: DST days are 23 or 25 h)
            const diff = Math.round((new Date(e.startMs).setHours(0, 0, 0, 0) - new Date(t).setHours(0, 0, 0, 0)) / 864e5);
            if (diff === 0) return (new Date(e.startMs).getHours() >= 17 ? 'Tonight ' : 'Today ') + time;
            if (diff === 1) return 'Tomorrow ' + time;
            const opts = diff >= 0 && diff < 6 ? { weekday: 'short' } : { weekday: 'short', month: 'short', day: 'numeric' };
            return new Intl.DateTimeFormat(undefined, opts).format(d) + ' ' + time;
        } catch (err) { return d.toUTCString(); }
    }
    // the long form, with the zone, for a tooltip
    function localFull(e) {
        try {
            return new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(new Date(e.startMs));
        } catch (err) { return new Date(e.startMs).toUTCString(); }
    }

    // An .ics file for "Add to calendar". Lines fold at 74 chars (RFC 5545).
    const fold = (l) => { let out = l.slice(0, 74); for (let i = 74; i < l.length; i += 73) out += '\r\n ' + l.slice(i, i + 73); return out; };
    function ics(e) {
        const stamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
        const esc = (s) => String(s).replace(/[\\;,]/g, (c) => '\\' + c).replace(/\n/g, '\\n');
        return [
            'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Corez.io//Events//EN', 'CALSCALE:GREGORIAN',
            'BEGIN:VEVENT',
            // the old domain on purpose: calendars that already have an event
            // would get a second copy if its UID changed
            'UID:' + e.id + '@corez.games',
            'DTSTAMP:' + stamp(e.startMs - 7 * 864e5),
            'DTSTART:' + stamp(e.startMs),
            'DTEND:' + stamp(e.endMs),
            'SUMMARY:' + esc(e.name + ' on Corez.io'),
            'DESCRIPTION:' + esc(e.blurb + '\n' + SITE + '\nDiscord: ' + DISCORD),
            'URL:' + SITE,
            'BEGIN:VALARM', 'TRIGGER:-PT15M', 'ACTION:DISPLAY', 'DESCRIPTION:' + esc(e.name + ' starts in 15 minutes'), 'END:VALARM',
            'END:VEVENT', 'END:VCALENDAR',
        ].map(fold).join('\r\n') + '\r\n';
    }

    return Object.freeze({ EVENTS: LIST, DISCORD, SITE, MENU_LEAD_MS, HUD_LEAD_MS, SOON_MS, now, current, countdown, localWhen, localFull, ics, fake });
});
