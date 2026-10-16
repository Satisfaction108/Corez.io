(function () {
    'use strict';

    var THEME_KEY = 'osaHomeTheme';
    var BAR_COLORS = { light: '#e4e4e4', dark: '#2a2b30' };
    var root = document.documentElement;

    function storedTheme() {
        try { return localStorage.getItem(THEME_KEY) === 'dark' ? 'dark' : 'light'; } catch (e) { return 'light'; }
    }
    function syncThemeChrome() {
        var t = root.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
        var icon = document.getElementById('themeIcon');
        if (icon) icon.textContent = t === 'light' ? '\u2600' : '\u263E';
        var bar = document.querySelector('meta[name="theme-color"]');
        if (bar) bar.setAttribute('content', BAR_COLORS[t]);
    }
    function applyTheme(t) {
        root.setAttribute('data-theme', t);
        try { localStorage.setItem(THEME_KEY, t); } catch (e) { }
        syncThemeChrome();
    }
    applyTheme(storedTheme());
    new MutationObserver(syncThemeChrome).observe(root, { attributes: true, attributeFilter: ['data-theme'] });

    function syncFresh() {
        var F = window.DWFunnel;
        if (F && F.hasPlayed && F.hasPlayed()) root.classList.remove('dw-fresh');
    }

    var freshLogin = document.getElementById('freshLogin');
    if (freshLogin) freshLogin.onclick = function () {
        var a = window.dwAccount, F = window.DWFunnel;
        if (a && a.openLogin) return a.openLogin();
        if (F && F.withAccountUi) F.withAccountUi(function (acct) { if (acct.openLogin) acct.openLogin(); });
    };

    window.dwHomeWorld = window.dwHomeWorld || {
        ready: function () { return !!document.getElementById('homeBackdrop'); }
    };

    var acctHint = localStorage.getItem('dwAcctHint') || 'guest';
    document.documentElement.setAttribute('data-acct', window.dwEmbed && acctHint === 'new' ? 'guest' : acctHint);

    /* ── Fullscreen ────────────────────────────────────────────────────
       A button on the menu (left rail) and one in game (app.js, next to the
       chat toggle). Portals frame us; their iframe has to allow fullscreen,
       otherwise fullscreenEnabled is false and both buttons stay hidden. */
    var fsDoc = document;
    function fsElement() { return fsDoc.fullscreenElement || fsDoc.webkitFullscreenElement || null; }
    window.dwFullscreen = {
        supported: function () {
            return !!(fsDoc.fullscreenEnabled || fsDoc.webkitFullscreenEnabled);
        },
        isOn: function () { return !!fsElement(); },
        toggle: function () {
            try {
                if (fsElement()) {
                    (fsDoc.exitFullscreen || fsDoc.webkitExitFullscreen).call(fsDoc);
                    return;
                }
                var el = fsDoc.documentElement;
                var go = el.requestFullscreen || el.webkitRequestFullscreen;
                var p = go && go.call(el);
                if (p && p.catch) p.catch(function () { /* refused, e.g. no user gesture */ });
            } catch (e) { /* not allowed here */ }
        }
    };
    function syncFullscreenButtons() {
        var on = window.dwFullscreen.isOn();
        document.documentElement.classList.toggle('dw-fs', on);
        document.querySelectorAll('.dw-fs-toggle').forEach(function (b) {
            b.title = on ? 'Exit fullscreen' : 'Fullscreen';
            b.setAttribute('aria-label', b.title);
        });
    }
    fsDoc.addEventListener('fullscreenchange', syncFullscreenButtons);
    fsDoc.addEventListener('webkitfullscreenchange', syncFullscreenButtons);

    /* ── Phones and tablets ─────────────────────────────────────────────
       Touch play has twin sticks, so touch-primary devices get a one-line
       hint above Play (held upright it also says to turn sideways).
       "(hover: hover) and (pointer: fine)" is true on laptops (even
       touchscreen ones); iPadOS claims to be a Mac, so maxTouchPoints
       catches it. */
    function isTouchOnlyDevice() {
        var precisePointer = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
        var touchCapable = navigator.maxTouchPoints > 1 ||
            /Android|webOS|iPhone|iPad|iPod|BlackBerry/i.test(navigator.userAgent);
        return touchCapable && !precisePointer;
    }

    function initMobileNote() {
        var note = document.getElementById('mobileNote');
        if (!note || !isTouchOnlyDevice()) return;
        note.hidden = false;
        // plugging in a mouse or trackpad flips the media query
        var mq = window.matchMedia('(hover: hover) and (pointer: fine)');
        var onChange = function (e) { note.hidden = e.matches; };
        if (mq.addEventListener) mq.addEventListener('change', onChange);
        else if (mq.addListener) mq.addListener(onChange); // older Safari
    }

    /* Phones: go full screen on the first tap anywhere, like arras.io does.
       Browsers only allow it inside a tap, so it can't happen on load. Once per
       page load, never in the installed app or an embed, and not if the player
       already turned it off with the button. Play (touch.js) still asks too. */
    function initTapFullscreen() {
        if (!isTouchOnlyDevice() || window.dwEmbed || !window.dwFullscreen.supported()) return;
        if (window.matchMedia && (matchMedia('(display-mode: standalone)').matches || matchMedia('(display-mode: fullscreen)').matches)) return;
        var go = function (e) {
            document.removeEventListener('touchend', go, true);
            if (window.dwFsUserOff || window.dwFullscreen.isOn()) return;
            // the fullscreen button does its own thing
            if (e && e.target && e.target.closest && e.target.closest('#homeFullscreenBtn')) return;
            try {
                var el = document.documentElement;
                var req = el.requestFullscreen || el.webkitRequestFullscreen;
                var p = req && req.call(el, { navigationUI: 'hide' });
                var lock = function () {
                    try {
                        var o = screen.orientation;
                        if (o && o.lock && Math.min(screen.width, screen.height) < 600) {
                            var q = o.lock('landscape');
                            if (q && q.catch) q.catch(function () { });
                        }
                    } catch (err) { }
                };
                if (p && p.then) p.then(lock, function () { });
            } catch (err) { }
        };
        document.addEventListener('touchend', go, true);
    }

    /* iPhone (and iPod) Safari: pages can't go full screen, an icon on the
       home screen can (manifest.webmanifest). Shown until dismissed, at most
       on three visits, never inside the installed app or an embed. */
    function initA2hsTip() {
        var tip = document.getElementById('a2hsTip');
        if (!tip || window.dwEmbed) return;
        // not before the first raid: Play is the only thing a first-timer needs
        if (window.DWFunnel && !window.DWFunnel.hasPlayed()) return;
        var ios = /iPhone|iPod/.test(navigator.userAgent);
        var installed = navigator.standalone || (window.matchMedia && matchMedia('(display-mode: standalone)').matches);
        if (!ios || installed) return;
        var KEY = 'dwA2hsTip_v1', n = 0;
        try { n = parseInt(localStorage.getItem(KEY) || '0', 10) || 0; } catch (e) { }
        if (n < 0 || n >= 3) return;
        try { localStorage.setItem(KEY, String(n + 1)); } catch (e) { }
        tip.hidden = false;
        tip.querySelector('.a2hs-x').onclick = function () {
            tip.hidden = true;
            try { localStorage.setItem(KEY, '-1'); } catch (e) { }
        };
    }

    /* ── Tutorial entry ────────────────────────────────────────────────
       The tutorial runs on an unlisted server (id "tut") that is absent from
       /getServers.json. It is fetched by id, the socket is pointed at it, and
       the game starts as Play would. Bump the storage key's version to re-run
       the tutorial for everyone. */
    var TUT_DONE_KEY = 'digRoyaleTutorialDone_v1';

    function tutorialCompleted() {
        return localStorage.getItem(TUT_DONE_KEY) === '1';
    }

    function whenClientReady(ok, fail) {
        var n = 0;
        (function tick() {
            if (window.global && window.global.startGame) return ok(window.global);
            if (++n > 200) return fail && fail();
            setTimeout(tick, 50);
        })();
    }

    function gameHost(sv) {
        // Dial the page's own host for proxied servers: Config.host can differ
        // from the public URL and point at a port Caddy does not expose.
        if (sv && sv.proxyPath) return location.host;
        return (sv && sv.ip) || location.host;
    }

    function launchTutorial(btn) {
        if (btn) { btn.disabled = true; }
        whenClientReady(function (g) {
            fetch('/getTutorialServer.json', { cache: 'no-store' })
                .then(function (r) {
                    if (!r.ok) throw new Error('tutorial http ' + r.status);
                    return r.json();
                })
                .then(function (sv) {
                    if (!sv || !(sv.ip || sv.proxyPath)) throw new Error('tutorial server unavailable');
                    if (sv.maxPlayers && sv.players >= sv.maxPlayers) {
                        if (btn) { btn.disabled = false; }
                        alert('The tutorial is full right now. Please try again in a minute.');
                        return;
                    }
                    g.serverAdd = gameHost(sv);
                    g.serverPath = sv.proxyPath || "";
                    g.tutorialMode = true;
                    g.tutorialPlot = null;
                    g.launchingTutorial = true;
                    location.hash = '#tut';
                    g.startGame();
                })
                .catch(function () {
                    if (btn) { btn.disabled = false; }
                    alert("Couldn't reach the tutorial server. Please try again in a moment.");
                });
        }, function () {
            if (btn) { btn.disabled = false; }
            alert('The game is still loading. Give it a moment and try again.');
        });
    }

    function launchDigWars(btn) {
        if (btn) { btn.disabled = true; }
        whenClientReady(function (g) {
            fetch('/getDigWarsServer.json', { cache: 'no-store' })
                .then(function (r) {
                    if (!r.ok) throw new Error('dig wars http ' + r.status);
                    return r.json();
                })
                .then(function (sv) {
                    if (!sv || !(sv.ip || sv.proxyPath)) throw new Error('dig wars server unavailable');
                    g.serverAdd = gameHost(sv);
                    g.serverPath = sv.proxyPath || "";
                    g.tutorialMode = false;
                    g.launchingDigWars = true;
                    location.hash = '#dw';
                    g.startGame();
                })
                .catch(function () {
                    if (btn) { btn.disabled = false; }
                    alert("Couldn't reach Corez.io 2TDM. Please try again in a moment.");
                });
        }, function () {
            if (btn) { btn.disabled = false; }
            alert('The game is still loading. Give it a moment and try again.');
        });
    }

    /* The tutorial's send-off Play button can't start a real game on the
       tutorial connection, so it sets PLAY_AFTER_KEY and reloads the menu.
       Here Play is pressed once a server is picked, unless an account overlay
       (welcome, sign-in) is up. */
    var PLAY_AFTER_KEY = 'dwPlayAfterTutorial';
    function playAfterTutorial() {
        var want = false;
        try { want = sessionStorage.getItem(PLAY_AFTER_KEY) === '1'; sessionStorage.removeItem(PLAY_AFTER_KEY); } catch (e) { }
        if (!want) return;
        var n = 0;
        (function tick() {
            var g = window.global;
            var blocked = window.dwAccount && window.dwAccount.blocksEnter && window.dwAccount.blocksEnter();
            if (g && g.startGame && g.serverAdd && !g.gameStart && !g.gameLoading && !blocked) {
                var b = document.getElementById('startButton');
                if (b && !b.disabled) b.click(); else g.startGame();
                return;
            }
            if (++n > 120) return;          // ~12 s: just stay on the menu
            setTimeout(tick, 100);
        })();
    }

    function initTutorialEntry() {
        var btn = document.getElementById('tutorialButton');
        var badge = document.getElementById('tutorialBadge');
        if (!btn) return;

        // Flags from the retired in-game tutorial.
        ['digwarsTutorialDone', 'digwarsStatsTaught', 'digwarsKind',
         'digwarsLessons', 'digwarsLessonsOff'].forEach(function (k) {
            localStorage.removeItem(k);
        });

        if (badge && !tutorialCompleted()) badge.hidden = false;
        btn.onclick = function () { launchTutorial(btn); };
    }

    function ordinal(n) {
        var t = n % 100, u = n % 10;
        return n + (t >= 11 && t <= 13 ? 'th' : u === 1 ? 'st' : u === 2 ? 'nd' : u === 3 ? 'rd' : 'th');
    }
    function initChampions() {
        var holder = document.querySelector('.startButtonHolder');
        if (!holder || !window.fetch) return;
        var guest = '';
        try { guest = localStorage.getItem('dwGuestId') || ''; } catch (e) { }
        var json = function (r) { return r.ok ? r.json() : null; };
        var none = function () { return null; };
        Promise.all([
            fetch('/api/champions', { credentials: 'same-origin' }).then(json, none),
            fetch('/api/champions/me', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-DW': '1' }, body: JSON.stringify(/^[a-f0-9]{32}$/.test(guest) ? { guestId: guest } : {}) }).then(json, none)
        ]).then(function (res) {
            var d = res[0], me = res[1];
            if (!d || !d.on) return;
            var champs = d.champs || [], top = d.top || [], mine = [];
            if (me && me.yesterday && me.yesterday.place) mine.push('You were ' + ordinal(me.yesterday.place) + ' yesterday.');
            if (me && me.today && me.today.place) mine.push((mine.length ? 'Today' : 'Today you are') + ' ' + ordinal(me.today.place) + ' of ' + me.today.of + ' so far.');
            if (!champs.length && !top.length && !mine.length) return;
            var box = document.createElement('div');
            box.id = 'aoChampions';
            box.className = 'ao-champs';
            if (mine.length) {
                var y = document.createElement('div');
                y.className = 'ao-you';
                y.textContent = mine.join(' ');
                box.appendChild(y);
            }
            if (champs.length) {
                var a = document.createElement('div');
                var lab = document.createElement('b');
                lab.className = 'ao-label';
                lab.textContent = "Yesterday's champions: ";
                a.appendChild(lab);
                a.appendChild(document.createTextNode(champs.map(function (c) { return c.place + '. ' + c.name; }).join(',  ')));
                box.appendChild(a);
            }
            if (top.length) {
                var b = document.createElement('div');
                var mins = Math.max(1, Math.ceil((d.resetIn || 0) / 60000));
                var left = mins >= 60 ? Math.floor(mins / 60) + 'h ' + (mins % 60) + 'm' : mins + 'm';
                b.className = 'ao-lead';
                b.textContent = top[0].name + ' leads today with ' + (top[0].score | 0).toLocaleString('en-US') + ' points. The board resets in ' + left + '.';
                box.appendChild(b);
            }
            holder.parentNode.insertBefore(box, holder.nextSibling);
        }).catch(function () { });
    }

    document.addEventListener('DOMContentLoaded', function () {
        initChampions();
        initMobileNote();
        initTapFullscreen();
        initA2hsTip();
        initTutorialEntry();
        playAfterTutorial();
        // #dw no longer routes anywhere (Dig Wars is parked); drop a stale hash.
        if (location.hash === '#dw') { try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { location.hash = ''; } }

        applyTheme(storedTheme());
        syncFresh();

        var fsBtn = document.getElementById('homeFullscreenBtn');
        if (fsBtn) {
            if (window.dwFullscreen.supported()) {
                fsBtn.hidden = false;
                fsBtn.onclick = function () { window.dwFullscreen.toggle(); fsBtn.blur(); };
            }
            syncFullscreenButtons();
        }

        // the toggle is wired in index.html, right under the button

        var panel = document.getElementById('homeSettingsPanel');
        var overlay = document.getElementById('homeSettingsOverlay');
        var openBtn = document.getElementById('homeSettingsBtn');
        var closeBtn = document.getElementById('homeSettingsClose');

        function openP() { panel.classList.add('open'); overlay.classList.add('visible'); }
        function closeP() {
            panel.classList.remove('open'); overlay.classList.remove('visible');
            // if the game is running, hand the keyboard back to it
            var gaw = document.getElementById('gameAreaWrapper');
            var cv = document.getElementById('gameCanvas');
            if (gaw && cv && gaw.style.display !== 'none') cv.focus();
        }

        if (openBtn) openBtn.onclick = openP;
        if (closeBtn) closeBtn.onclick = closeP;
        if (overlay) overlay.onclick = closeP;

        var tabs = document.querySelectorAll('.sp-tab');
        tabs.forEach(function (tab) {
            tab.onclick = function () {
                tabs.forEach(function (t) { t.classList.remove('active'); });
                document.querySelectorAll('.sp-pane').forEach(function (p) { p.classList.remove('active'); });
                tab.classList.add('active');
                var el = document.getElementById(tab.getAttribute('data-tab'));
                if (el) el.classList.add('active');
            };
        });

        var clPanel = document.getElementById('homeChangelogPanel');
        var clOverlay = document.getElementById('homeChangelogOverlay');
        var clOpenBtn = document.getElementById('homeChangelogBtn');
        var clCloseBtn = document.getElementById('homeChangelogClose');

        function openCL() { clPanel.classList.add('open'); clOverlay.classList.add('visible'); }
        function closeCL() { clPanel.classList.remove('open'); clOverlay.classList.remove('visible'); }

        if (clOpenBtn) clOpenBtn.onclick = openCL;
        if (clCloseBtn) clCloseBtn.onclick = closeCL;
        if (clOverlay) clOverlay.onclick = closeCL;

        // contributors modal - opened from the sidebar credits line
        var contribPanel = document.getElementById('contributorsPanel');
        var contribOverlay = document.getElementById('contributorsOverlay');
        var contribLink = document.getElementById('contributorsLink');
        var contribClose = document.getElementById('contributorsClose');
        function openContrib() {
            if (contribPanel) { contribPanel.classList.add('open'); contribOverlay.classList.add('visible'); }
        }
        function closeContrib() {
            if (contribPanel) { contribPanel.classList.remove('open'); contribOverlay.classList.remove('visible'); }
        }
        if (contribLink) contribLink.onclick = openContrib;
        if (contribClose) contribClose.onclick = closeContrib;
        if (contribOverlay) contribOverlay.onclick = closeContrib;

        // region dropdown (server selector)
        var dd = document.getElementById('serverDropdown');
        var ddTrigger = document.getElementById('serverDropdownTrigger');
        var ddLabel = document.getElementById('serverDropdownLabel');
        var regionSelector = document.getElementById('regionSelector');

        function showToast(message) {
            var container = document.getElementById('toastContainer');
            if (!container) return;
            var toast = document.createElement('div');
            toast.className = 'toast';
            toast.textContent = message;
            container.appendChild(toast);
            setTimeout(function () {
                toast.classList.add('hide');
                setTimeout(function () { toast.remove(); }, 300);
            }, 2600);
        }
        var ytSoon = document.getElementById('ytSoon');
        if (ytSoon) ytSoon.onclick = function () { showToast('There is no YouTube channel yet, but maybe soon!'); };

        // Regions with live servers get a count and are selectable. The first
        // live region is selected unless the player picked another live one.
        var regionPicked = false;
        function normRegion(r) {
            r = String(r || '').toLowerCase().trim();
            if (r.indexOf('euro') === 0 || r === 'eu') return 'Europe';
            if (r.indexOf('amer') === 0 || r.indexOf('usa') === 0 || r === 'us' || r.indexOf('us ') === 0 || r.indexOf('us-') === 0 || r.indexOf('north america') === 0) return 'USA';
            if (r.indexOf('asia') === 0) return 'Asia';
            return null;
        }
        var liveRegions = {};
        function updateRegionLabel() {
            if (!ddLabel) return;
            var selected = regionSelector ? regionSelector.querySelector('.region-option.selected') : null;
            var name = (selected && selected.querySelector('.region-name') && selected.querySelector('.region-name').textContent) || (selected && selected.dataset.region) || 'USA';
            var countEl = selected ? selected.querySelector('.region-count') : null;
            var count = countEl && countEl.style.display !== 'none' ? countEl.textContent.trim() : '';
            ddLabel.textContent = count ? name + ' \u2022 ' + count : name;
        }

        function renderRegionCounts(serverData) {
            var data = Array.isArray(serverData) ? serverData : [];
            var counts = {}, labels = {};
            data.forEach(function (s) {
                var key = normRegion(s.region);
                if (!key) return;
                counts[key] = (counts[key] || 0) + (Number(s.players) || 0);
                if (!labels[key]) labels[key] = String(s.region);
            });
            liveRegions = counts;
            if (!regionSelector) return;
            var opts = regionSelector.querySelectorAll('.region-option');
            opts.forEach(function (opt) {
                var countEl = opt.querySelector('.region-count');
                var nameEl = opt.querySelector('.region-name');
                var key = opt.dataset.region;
                if (nameEl && labels[key]) nameEl.textContent = key === 'USA' && /east/i.test(labels[key]) ? 'US East' : key;
                if (!countEl) return;
                if (counts[key] !== undefined) {
                    countEl.textContent = counts[key];
                    countEl.style.display = '';
                } else {
                    countEl.style.display = 'none';
                }
            });
            var selected = regionSelector.querySelector('.region-option.selected');
            var keys = Object.keys(counts);
            if (keys.length && (!selected || counts[selected.dataset.region] === undefined || !regionPicked)) {
                var want = regionSelector.querySelector('.region-option[data-region="' + keys[0] + '"]');
                if (want && want !== selected) {
                    if (selected) selected.classList.remove('selected');
                    want.classList.add('selected');
                }
            }
            updateRegionLabel();
        }
        if (window.global) window.global.updateRegionSelector = renderRegionCounts;

        function setDropdownOpen(open) {
            if (dd) dd.classList.toggle('open', !!open);
        }

        if (ddTrigger) {
            ddTrigger.onclick = function (e) {
                e.stopPropagation();
                setDropdownOpen(!dd.classList.contains('open'));
            };
        }
        document.addEventListener('click', function (e) {
            if (dd && !dd.contains(e.target)) setDropdownOpen(false);
        });

        if (regionSelector) {
            regionSelector.addEventListener('click', function (e) {
                var opt = e.target.closest ? e.target.closest('.region-option') : null;
                if (!opt) return;
                var selected = regionSelector.querySelector('.region-option.selected');
                if (liveRegions[opt.dataset.region] !== undefined) {
                    regionPicked = true;
                    if (selected && selected !== opt) {
                        selected.classList.remove('selected');
                        opt.classList.add('selected');
                    }
                    setDropdownOpen(false);
                    updateRegionLabel();
                } else {
                    showToast('No servers in ' + opt.dataset.region + ' yet');
                }
            });
        }

        var selTbody = document.getElementById('serverSelector');
        if (selTbody) {
            selTbody.addEventListener('click', function () {
                setDropdownOpen(false);
                updateRegionLabel();
            });
            new MutationObserver(updateRegionLabel).observe(selTbody, {
                childList: true,
                subtree: true,
                attributes: true,
                attributeFilter: ['class']
            });
        }
        setTimeout(function () {
            if (window.global) renderRegionCounts(window.global.servers);
        }, 600);

        // Poll counts while on the menu, and immediately when it comes back.
        function refreshCounts() {
            var gaw = document.getElementById('gameAreaWrapper');
            if (gaw && gaw.style.display !== 'none') return;
            fetch('/getServers.json', { cache: 'no-store' })
                .then(function (r) { return r.json(); })
                .then(function (data) {
                    if (window.global) window.global.servers = data;
                    renderRegionCounts(data);
                    if (window.global && window.global.refreshServerCounts) window.global.refreshServerCounts(data);
                    // the first list never made it (see app.js onload): use this one
                    var sb = document.getElementById('startButton');
                    if (sb && sb.disabled && window.global && window.global.loadServerSelector) window.global.loadServerSelector(data);
                })
                .catch(function () {});
        }
        refreshCounts();
        setInterval(refreshCounts, 5000);
        var gawEl = document.getElementById('gameAreaWrapper');
        if (gawEl && window.MutationObserver) {
            var wasHidden = gawEl.style.display === 'none';
            new MutationObserver(function () {
                var hidden = gawEl.style.display === 'none';
                if (hidden && !wasHidden) refreshCounts();
                wasHidden = hidden;
            }).observe(gawEl, { attributes: true, attributeFilter: ['style'] });
        }
        document.addEventListener('visibilitychange', function () {
            if (!document.hidden) refreshCounts();
        });

        var clTabs = document.querySelectorAll('.cl-tab');
        var patchNotes = document.getElementById('patchNotes');
        clTabs.forEach(function (tab) {
            tab.onclick = function () {
                clTabs.forEach(function (t) { t.classList.remove('active'); });
                tab.classList.add('active');
                if (patchNotes) {
                    patchNotes.className = 'shadowScroll ' + tab.getAttribute('data-type');
                }
            };
        });

        var world = window.dwHomeWorld && window.dwHomeWorld.build ? window.dwHomeWorld : null;
        var canvas = document.getElementById('homeWorldCanvas');
        var ctx = canvas ? canvas.getContext('2d') : null;
        var W = 0, H = 0, dpr = 1, homeFxOn = true, homeFxRaf = 0, homeFxLast = 0;
        var reduceMotion = !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
        var worldIn = 0, worldWanted = false, worldTimer = 0, bakeGen = 0, bakedOnce = false;
        var idle = window.requestIdleCallback
            ? function (f) { requestIdleCallback(f, { timeout: 500 }); }
            : function (f) { setTimeout(f, 16); };
        function bakeWorld(lo) {
            worldTimer = 0;
            if (!world || !homeFxOn || !ctx) return;
            var gen = ++bakeGen, cheap = lo === true || (!bakedOnce && dpr > 0.75);
            try { world.build(W, H, cheap ? 0.5 : dpr, root.getAttribute('data-theme') === 'light'); } catch (e) { world = null; return; }
            (function slice() {
                if (gen !== bakeGen || !world || !homeFxOn) return;
                var done;
                try { done = world.step(8); } catch (e) { world = null; return; }
                if (!done) { if (cheap) setTimeout(slice, 0); else idle(slice); return; }
                bakedOnce = true;
                if (!homeFxRaf) drawHomeFx(performance.now());
                if (cheap) worldTimer = setTimeout(function () { idle(function () { bakeWorld(false); }); }, 400);
            })();
        }
        function wantWorld(delay) {
            worldWanted = true;
            if (!world) return;
            clearTimeout(worldTimer);
            worldTimer = setTimeout(function () { idle(bakeWorld); }, delay);
        }
        function resizeWorld() {
            if (!ctx) return;
            dpr = Math.min(window.devicePixelRatio || 1, 2);
            W = window.innerWidth;
            H = window.innerHeight;
            canvas.width = Math.max(1, Math.floor(W * dpr));
            canvas.height = Math.max(1, Math.floor(H * dpr));
            canvas.style.width = W + 'px';
            canvas.style.height = H + 'px';
            if (worldWanted) wantWorld(150);
            if (reduceMotion && !homeFxRaf) drawHomeFx(performance.now());
        }
        function drawHomeFx(now) {
            homeFxRaf = 0;
            if (!homeFxOn || !ctx) return;
            if (!reduceMotion) homeFxRaf = requestAnimationFrame(drawHomeFx);
            if (!reduceMotion && now - homeFxLast < 32) return;
            homeFxLast = now;
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.clearRect(0, 0, W, H);
            if (world && world.ready()) {
                worldIn = reduceMotion ? 1 : Math.min(1, worldIn + 0.1);
                world.draw(ctx, now, reduceMotion, worldIn);
            }
            ctx.globalAlpha = 1;
        }
        if (world && ctx) {
            resizeWorld();
            window.addEventListener('resize', resizeWorld);
            requestAnimationFrame(function () { setTimeout(function () { wantWorld(0); }, 0); });
            new MutationObserver(function () { if (worldWanted) wantWorld(0); }).observe(root, { attributes: true, attributeFilter: ['data-theme'] });
            drawHomeFx(performance.now());
        }

        var homeUI = [
            document.getElementById('themeToggleBtn'),
            document.getElementById('homeSettingsBtn'),
            document.getElementById('homeChangelogBtn'),
            document.getElementById('homeSidebar'),
            document.getElementById('homeBackdrop')
        ];

        function dailyFeaturedTanks() {
            if (window.tankRecords && typeof window.tankRecords.dailyFeaturedFor === 'function') {
                return window.tankRecords.dailyFeaturedFor();
            }
            var pool = [
                'Annihilator', 'Hybrid', 'Skimmer', 'Destroyer',
                'Overlord', 'Manager', 'Factory', 'Battleship',
                'Penta Shot', 'Spreadshot', 'Triplet', 'Streamliner',
                'Predator', 'Ranger', 'Stalker', 'Crossbow',
                'Fighter', 'Booster', 'Bomber', 'Auto-Tri-Angle',
                'Auto-Gunner', 'Nailgun', 'Minigun', 'Sprayer',
                'Builder', 'Architect', 'Gunner Trapper', 'Boomer'
            ];
            var dk = new Date(Math.floor(Date.now() / 86400000) * 86400000).toISOString().slice(0, 10);
            var str = 'dw-featured-' + dk, h = 0x811c9dc5;
            for (var i = 0; i < str.length; i++) {
                h ^= str.charCodeAt(i);
                h = Math.imul(h, 0x01000193);
            }
            var a = h >>> 0;
            function rand() {
                a = (a + 0x6D2B79F5) >>> 0;
                var t = Math.imul(a ^ (a >>> 15), 1 | a);
                t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
                return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
            }
            var picked = [];
            while (picked.length < 3 && pool.length) {
                var idx = Math.floor(rand() * pool.length) % pool.length;
                picked.push(pool.splice(idx, 1)[0]);
            }
            return picked;
        }

        function loadTankRecordsList() {
            if (window.tankRecords && typeof window.tankRecords.allRecords === 'function') {
                return window.tankRecords.allRecords();
            }
            var out = [];
            try {
                var raw = localStorage.getItem('dwTankPB');
                if (raw) {
                    var obj = JSON.parse(raw);
                    if (obj && typeof obj === 'object') {
                        Object.keys(obj).forEach(function (tk) {
                            var rec = obj[tk];
                            if (rec && ((rec.s | 0) > 0 || (rec.k | 0) > 0)) {
                                out.push({ tank: tk, score: rec.s | 0, kills: rec.k | 0 });
                            }
                        });
                    }
                }
            } catch (e) { }
            out.sort(function (x, y) { return (y.score - x.score) || (y.kills - x.kills); });
            return out;
        }

        function escHtml(s) {
            return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        }

        function renderHomeDailyAndRecords() {
            var box = document.getElementById('homeDailyAndRecords');
            if (!box) return;
            var featured = dailyFeaturedTanks();
            var recs = loadTankRecordsList();
            var ftPills = featured.map(function (name) {
                var rec = recs.find(function (r) { return r.tank === name; });
                var pbSub = rec && rec.score > 0 ? ' <span class="hdr-pill-sub">· PB ' + rec.score.toLocaleString('en-US') + '</span>' : '';
                return '<span class="hdr-pill hdr-pill-ft">' +
                    '<span class="hdr-star">★</span><span>' + escHtml(name) + '</span>' + pbSub + '</span>';
            }).join('');

            var pbHtml = '';
            if (recs.length > 0) {
                var topRecs = recs.map(function (r) {
                    var kBit = r.kills > 0 ? ' · ' + r.kills + ' KO' + (r.kills === 1 ? '' : 's') : '';
                    return '<span class="hdr-pill hdr-pill-pb">' +
                        '<span class="hdr-pb-tank">' + escHtml(r.tank) + ':</span><span class="hdr-pb-val">' + r.score.toLocaleString('en-US') + ' pts' + escHtml(kBit) + '</span></span>';
                }).join('');
                pbHtml = '<div class="hdr-pb-sec">' +
                    '<div class="hdr-head hdr-head-sub">Your Best Runs by Tank (' + recs.length + ')</div>' +
                    '<div class="hdr-pills hdr-pills-scroll">' + topRecs + '</div>' +
                    '</div>';
            }

            box.removeAttribute('style');
            box.innerHTML =
                '<div class="hdr-head">' +
                'Today\'s Featured Tanks <span class="hdr-bonus">(+25% Bonus Pts)</span></div>' +
                '<div class="hdr-pills">' + ftPills + '</div>' +
                pbHtml;
        }
        window.renderHomeDailyAndRecords = renderHomeDailyAndRecords;
        renderHomeDailyAndRecords();

        var smw = document.getElementById('startMenuWrapper');
        if (smw) {
            new MutationObserver(function () {
                var hidden = smw.style.display === 'none' || parseInt(smw.style.top) < -100;
                homeUI.forEach(function (el) { if (el) el.style.display = hidden ? 'none' : ''; });
                document.body.classList.toggle('in-game', hidden);
                homeFxOn = !hidden;
                if (hidden) {
                    closeCL(); closeP(); setDropdownOpen(false);
                    if (homeFxRaf) { cancelAnimationFrame(homeFxRaf); homeFxRaf = 0; }
                    if (world) { world.release(); worldIn = 0; }
                } else {
                    syncFresh();
                    renderHomeDailyAndRecords();
                    if (world && worldWanted) wantWorld(0);
                    if (ctx && !homeFxRaf) drawHomeFx(performance.now());
                }
            }).observe(smw, { attributes: true, attributeFilter: ['style'] });
        }

        var grid = document.getElementById('homeKeybindGrid');
        var hidden = document.getElementById('controlSettings');
        if (!grid || !hidden) return;

        grid.onclick = function (e) {
            var b = e.target.closest('b[data-key]');
            if (!b) return;
            // the document handler would unselect the cell the proxy just selected
            e.stopPropagation();
            var hb = hidden.querySelector('b[data-key="' + b.getAttribute('data-key') + '"]');
            if (hb) hb.click();
        };

        function sync() {
            hidden.querySelectorAll('b[data-key]').forEach(function (src) {
                var dst = grid.querySelector('b[data-key="' + src.getAttribute('data-key') + '"]');
                if (!dst) return;
                dst.textContent = src.textContent || '·';
                // mirror the "waiting for a key" state onto the visible grid
                dst.classList.toggle('kb-editing', !!src.closest('.editing'));
            });
        }
        setTimeout(sync, 500);
        new MutationObserver(sync).observe(hidden, { subtree: true, characterData: true, childList: true, attributes: true, attributeFilter: ['class'] });
    });
})();
