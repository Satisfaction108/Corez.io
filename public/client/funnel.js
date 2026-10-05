// The path from opening the page to the first raid: it makes Play work from
// the first paint and measures each step of the way (POST /api/funnel, our
// own server, nothing third party).
//
// Loaded with `defer` in <head>, so it runs before every module script and
// before home.js's DOMContentLoaded work.
//
//   Play early   the Play button is on screen long before the game client
//                has loaded (about 1.5 MB of script). A press, Enter or Space
//                in that time is remembered: the button says "Starting" with
//                a progress bar and the game starts the moment it can.
//                While nothing is pressed the button shows the same bar.
//   Enter/Space  play from anywhere on the menu, unless you're typing or a
//                panel or dialog is open (Enter in the name box plays too)
//   portals      a first-time player on CrazyGames is started straight into
//                a raid (they ask for players to land in gameplay); invite
//                and party links still go through the menu
//   account UI   client/account/main.js (shop, locker, friends, top 100,
//                daily track) is added from here: at once for accounts, else
//                when the menu sits idle or the player is back from a raid,
//                so it never competes with the first Play
//   first-timer  hasPlayed() is false until this browser has been in control
//                of a tank once. Account popups, the daily track and tips
//                wait for that (home.js, account/main.js, retention.js)
//
// Funnel events, one row per page visit on the server (accounts/funnel.js):
//   load     the load event, ms from navigation start
//   home     the menu is on screen (no dialog over it), ms from navigation
//   ready    Play can start a game, ms from navigation
//   play     Play pressed (or auto-started): ms spent on the menu first
//   control  the first spawn, ms from navigation
//   min1     a minute in control (summed over the visit)
//   leave    the page closed or hidden before Play: ms on the page
// A visit is identified by a random id made here; it carries the browser's
// guest id, desktop or mobile, and the site it first came from (dwSrc).
(function (root, factory) {
    var api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else {
        root.DWFunnel = api;
        if (root.document && !root.__dwFunnelBooted) { root.__dwFunnelBooted = true; api.boot(root); }
    }
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    var PLAYED_KEY = 'dwPlayed';
    // Script files the menu needs before Play works (the app.js module graph
    // plus the shared rules). Only drives the progress bar; a test keeps it
    // close to the real count.
    var EXPECTED_JS = 64;
    var MINUTE = 60000;

    function get(ls, k) { try { return ls ? ls.getItem(k) : null; } catch (e) { return null; } }
    function set(ls, k, v) { try { if (ls) ls.setItem(k, v); } catch (e) { /* private mode */ } }

    // This browser has been in a raid before: the funnel's own flag, or the
    // older signs (raids finished, sessions counted, the tutorial done, an
    // account logged in here).
    function hasPlayed(ls) {
        if (get(ls, PLAYED_KEY) === '1') return true;
        if ((+get(ls, 'dwRaidsEnded') || 0) > 0 || (+get(ls, 'dwSessions') || 0) > 0) return true;
        if (get(ls, 'digRoyaleTutorialDone_v1') === '1') return true;
        return get(ls, 'dwAcctHint') === 'user';
    }

    // Straight into a raid: only a first-timer on CrazyGames, and never when
    // the link is about a party, a room or an invite.
    function shouldAutoStart(o) {
        if (!o || o.portal !== 'crazygames' || o.played) return false;
        if (/[?&](party|room|instantMultiplayer|invite|ref|join)=?/i.test(String(o.search || ''))) return false;
        if (/^#(tut|login|account|reset)/.test(String(o.hash || ''))) return false;
        return true;
    }

    function isMobile(nav, mm) {
        var precise = false;
        try { precise = !!(mm && mm('(hover: hover) and (pointer: fine)').matches); } catch (e) { /* */ }
        var touch = !!nav && ((nav.maxTouchPoints || 0) > 1 || /Android|webOS|iPhone|iPad|iPod|BlackBerry/i.test(nav.userAgent || ''));
        return touch && !precise;
    }

    // A key that should press Play. ctx: {ready, blocked, typing, onButton}
    function isPlayKey(e, ctx) {
        if (!e || e.repeat || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return false;
        var enter = e.key === 'Enter' || e.keyCode === 13;
        var space = e.key === ' ' || e.code === 'Space' || e.keyCode === 32;
        if (!enter && !space) return false;
        if (!ctx || ctx.blocked || ctx.onButton) return false;
        // in the name box Enter plays and Space is a space
        if (ctx.typing) return enter && ctx.typing === 'name';
        return true;
    }

    // The account UI (client/account/main.js) right away? Accounts, someone
    // who logged out here, and links that open an account screen.
    function accountUiNow(o) {
        if (!o) return true;
        if (o.hint === 'user' || o.hint === 'new') return true;
        // (party / instantMultiplayer: a portal's duo invite, client/portal.js)
        return /[?&](auth|link|ref|party|instantMultiplayer)=/i.test(String(o.search || '')) || /^#(reset=|login|account)/.test(String(o.hash || ''));
    }
    // ...otherwise when nothing would wait on it: the menu has been idle a
    // moment since it was wired, or the player is back from a game. Never
    // while a game is starting or running (it is a lot of script to run).
    // o: {ready, starting, inGame, idleMs, waitedMs, asked}
    var ACCT_IDLE_MS = 1500, ACCT_GIVE_UP_MS = 45000;
    function accountUiDue(o) {
        if (o.asked) return true;
        if (o.starting || o.inGame) return false;
        if (o.ready) return o.idleMs >= ACCT_IDLE_MS;
        return o.waitedMs >= ACCT_GIVE_UP_MS;
    }

    function progress(loadedJs) {
        return Math.max(0.04, Math.min(0.95, (loadedJs || 0) / EXPECTED_JS));
    }

    // The body of one funnel event. -> null if it isn't one we send.
    var EVENTS = ['load', 'home', 'ready', 'play', 'control', 'min1', 'leave'];
    function payload(meta, event, ms, extra) {
        if (EVENTS.indexOf(event) < 0) return null;
        var out = { v: meta.visit, e: event, t: Math.max(0, Math.round(+ms || 0)), d: meta.mobile ? 'mobile' : 'desktop', f: meta.first ? 1 : 0 };
        if (meta.guest) out.g = meta.guest;
        if (meta.source) out.s = meta.source;
        if (extra && extra.auto) out.a = 1;
        return out;
    }

    function hex(n, w) {
        var b = new Uint8Array(n);
        try { w.crypto.getRandomValues(b); } catch (e) { for (var i = 0; i < n; i++) b[i] = (Math.random() * 256) | 0; }
        return Array.prototype.map.call(b, function (x) { return (x < 16 ? '0' : '') + x.toString(16); }).join('');
    }

    /* ── browser ──────────────────────────────────────────────────────── */
    function boot(w) {
        var doc = w.document, perf = w.performance, ls = null;
        try { ls = w.localStorage; } catch (e) { ls = null; }
        var now = function () { return perf && perf.now ? perf.now() : Date.now(); };

        // first visit: no guest id yet (socketinit.js makes one right after this)
        var guest = get(ls, 'dwGuestId');
        var first = !/^[a-f0-9]{32}$/.test(guest || '');
        if (first) { guest = hex(16, w); set(ls, 'dwGuestId', guest); }
        var played = hasPlayed(ls);
        var meta = {
            visit: hex(16, w), guest: guest, first: first,
            mobile: isMobile(w.navigator, w.matchMedia ? w.matchMedia.bind(w) : null),
            source: String(get(ls, 'dwSrc') || '').slice(0, 56),
        };
        var sent = {}, homeAt = -1, played60 = 0, lastTick = 0, controlAt = -1, playAt = -1, auto = false;
        w.__funnelSent = sent;

        function send(event, ms, extra) {
            if (sent[event] && event !== 'leave') return;
            var body = payload(meta, event, ms, extra);
            if (!body) return;
            sent[event] = body.t;
            try {
                w.fetch('/api/funnel', {
                    method: 'POST', credentials: 'same-origin', keepalive: true,
                    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
                }).catch(function () { /* stats only */ });
            } catch (e) { /* old browser: no stats */ }
        }

        /* the account UI, see accountUiNow / accountUiDue */
        var acctAdded = false, acctAsked = false, readyAt = -1;
        function addAccountUi() {
            if (acctAdded) return;
            acctAdded = true;
            var s = doc.createElement('script');
            s.type = 'module';
            s.src = './client/account/main.js';
            doc.body.appendChild(s);
        }
        if (accountUiNow({ hint: get(ls, 'dwAcctHint'), search: w.location.search, hash: w.location.hash })) addAccountUi();
        // a tap on something it draws (tabs, the account chip, Solo | Duos)
        doc.addEventListener('pointerdown', function (e) {
            if (!acctAdded && e.target && e.target.closest && e.target.closest('#menuNav, #accountChip, #modeToggle, #lobbySide')) { acctAsked = true; addAccountUi(); }
        }, true);

        var api = w.DWFunnel;
        // run fn(window.dwAccount) once the account UI is up, loading it now
        api.withAccountUi = function (fn) {
            acctAsked = true;
            addAccountUi();
            var n = 0;
            (function wait() {
                if (w.dwAccount) { try { fn(w.dwAccount); } catch (e) { /* */ } return; }
                if (++n < 300) w.setTimeout(wait, 50);
            })();
        };
        api.firstVisit = function () { return first; };
        api.hasPlayed = function () { return played || hasPlayed(ls); };
        api.visitId = function () { return meta.visit; };

        /* the Play button before the game client is up */
        var btn = function () { return doc.getElementById('startButton'); };
        var client = function () { var g = w.global; return !!(g && g.startGame); };
        // app.js wires the button (onclick) once it has set up the menu
        var ready = function () { var b = btn(); return client() && !!b && typeof b.onclick === 'function'; };
        var blocked = function () {
            if (doc.body && doc.body.classList.contains('in-game')) return true;
            var a = w.dwAccount;
            if (a && a.blocksEnter && a.blocksEnter()) return true;
            if (doc.documentElement.getAttribute('data-acct') === 'new') return true;
            var open = doc.querySelector('#homeSettingsPanel.open, #homeChangelogPanel.open, #contributorsPanel.open, #dwWelcome.open, .region-dropdown.open');
            if (open) return true;
            var g = w.global;
            return !!(g && (g.gameStart || g.gameLoading));
        };
        var queued = null;   // 'click' | 'key' | 'auto'
        var label = null, bar = null, drawn = '';
        function decorate(state, p) {
            var b = btn();
            if (!b) return;
            var key = state + Math.round((p || 0) * 100);
            if (key === drawn && b.contains(label)) return;
            drawn = key;
            if (!label) {
                label = doc.createElement('span');
                label.className = 'play-load';
                label.setAttribute('aria-hidden', 'true');
                bar = doc.createElement('i');
                label.appendChild(bar);
                b.appendChild(label);
            }
            b.classList.toggle('dw-loading', state !== 'done');
            b.classList.toggle('dw-queued', state === 'queued');
            bar.style.width = Math.round((p || 0) * 100) + '%';
            var t = b.querySelector('b');
            if (t) t.textContent = state === 'queued' ? 'Starting…' : 'Play';
            b.setAttribute('aria-busy', state === 'done' ? 'false' : 'true');
        }
        function loadedJs() {
            try {
                return perf.getEntriesByType('resource').filter(function (r) { return /\.m?js(\?|$)/.test(r.name) && r.responseEnd > 0; }).length;
            } catch (e) { return 0; }
        }
        var pressAt = -1;   // when an early press happened: the menu time ends there
        function queue(why) {
            if (queued) return;
            queued = why;
            pressAt = now();
            if (why === 'auto') auto = true;
            decorate('queued', progress(loadedJs()));
        }

        doc.addEventListener('click', function (e) {
            var b = e.target && e.target.closest ? e.target.closest('#startButton') : null;
            if (!b || ready()) return;
            e.preventDefault();
            e.stopImmediatePropagation();
            queue('click');
        }, true);

        doc.addEventListener('keydown', function (e) {
            var t = e.target || {};
            var tag = String(t.tagName || '').toLowerCase();
            var typing = t.isContentEditable || tag === 'textarea' || tag === 'select' || (tag === 'input' && !/^(checkbox|radio|range|button|submit)$/i.test(t.type || ''))
                ? (t.id === 'playerNameInput' ? 'name' : 'other') : '';
            var ctx = {
                blocked: blocked() || (w.global && w.global.gameStart),
                typing: typing,
                onButton: tag === 'button' || tag === 'a' || tag === 'summary',
            };
            if (!isPlayKey(e, ctx)) return;
            // a key app.js listens for: once the menu is wired, Enter is its
            // (document.onkeydown); Space and anything earlier are ours
            var enter = e.key === 'Enter' || e.keyCode === 13;
            if (ready()) {
                if (enter) return;
                e.preventDefault();
                var b = btn();
                if (b && !b.disabled) b.click();
                return;
            }
            e.preventDefault();
            queue('key');
        }, true);

        /* steps */
        function visible(el) { return !!el && el.offsetParent !== null; }
        function tick() {
            var t = now();
            var b = btn();
            if (homeAt < 0 && doc.documentElement.getAttribute('data-acct') !== 'new' && visible(doc.querySelector('.startMenu'))) {
                // the menu is on screen from the first paint: count from that,
                // and wait for it (layout can be ready before the paint is)
                var fcp = null, paintApi = !!w.PerformancePaintTiming;
                try { fcp = (perf.getEntriesByType('paint').filter(function (p) { return p.name === 'first-contentful-paint'; })[0] || {}).startTime; } catch (e) { /* */ }
                if (typeof fcp === 'number' && fcp > 0) homeAt = fcp;
                else if (!paintApi) homeAt = t;
                if (homeAt >= 0) send('home', homeAt);
            }
            var isReady = ready() && b && !b.disabled;
            if (isReady && !sent.ready) send('ready', t);
            if (!sent.play) {
                if (isReady) decorate('done', 1);
                else decorate(queued ? 'queued' : 'loading', progress(loadedJs()));
                if (queued && isReady && !blocked()) {
                    var why = queued;
                    queued = null;
                    decorate('done', 1);
                    if (why === 'auto') auto = true;
                    b.click();
                }
            }
            var g = w.global;
            if (!acctAdded) {
                if (isReady && readyAt < 0) readyAt = t;
                var starting = !!(queued || (g && (g.gameLoading || g.gameStart)));
                if (starting) readyAt = -1;   // the idle wait starts over on the menu
                if (accountUiDue({ ready: readyAt >= 0, starting: starting, inGame: !!(doc.body && doc.body.classList.contains('in-game')),
                    idleMs: readyAt >= 0 ? t - readyAt : 0, waitedMs: t, asked: acctAsked })) addAccountUi();
            }
            if (playAt < 0 && g && g.gameLoading) {
                playAt = t;
                var pressed = pressAt >= 0 ? pressAt : t;
                send('play', Math.max(0, pressed - (homeAt >= 0 ? homeAt : 0)), { auto: auto });
            }
            var inControl = !!(w.dwPlaying && w.dwPlaying());
            if (inControl && controlAt < 0) {
                controlAt = t;
                send('control', t);
                if (!played) { played = true; set(ls, PLAYED_KEY, '1'); }
            }
            if (inControl && lastTick) played60 += Math.min(2000, t - lastTick);
            lastTick = inControl ? t : 0;
            if (played60 >= MINUTE) send('min1', t);
            // fast while the menu loads, then just often enough to catch Play
            // and the first spawn, then once a second for the minute
            var slow = sent.min1 !== undefined && acctAdded;
            w.setTimeout(tick, slow ? 5000 : sent.play !== undefined ? (sent.control === undefined ? 250 : 1000) : isReady && !queued ? 250 : 100);
        }
        tick();

        w.addEventListener('load', function () {
            var nav = null;
            try { nav = perf.getEntriesByType('navigation')[0]; } catch (e) { /* */ }
            w.setTimeout(function () { send('load', nav && nav.loadEventEnd > 0 ? nav.loadEventEnd : now()); }, 0);
        });
        var leave = function () { if (playAt < 0) send('leave', now()); };
        w.addEventListener('pagehide', leave);
        doc.addEventListener('visibilitychange', function () { if (doc.visibilityState === 'hidden') leave(); });

        // pressed before this ran (the catcher in index.html's <head>)
        if (w.dwPlayEarly) queue('click');
        // a first-timer on CrazyGames goes straight in
        if (shouldAutoStart({ portal: w.dwPortal, played: played, search: w.location.search, hash: w.location.hash })) queue('auto');
    }

    return {
        PLAYED_KEY: PLAYED_KEY, EXPECTED_JS: EXPECTED_JS, EVENTS: EVENTS,
        hasPlayed: hasPlayed, shouldAutoStart: shouldAutoStart, isMobile: isMobile,
        isPlayKey: isPlayKey, progress: progress, payload: payload, boot: boot,
        accountUiNow: accountUiNow, accountUiDue: accountUiDue, ACCT_IDLE_MS: ACCT_IDLE_MS,
    };
});
