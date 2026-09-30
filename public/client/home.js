(function () {
    'use strict';

    var THEME_KEY = 'osaHomeTheme';
    var root = document.documentElement;

    function applyTheme(t) {
        root.setAttribute('data-theme', t);
        localStorage.setItem(THEME_KEY, t);
        var icon = document.getElementById('themeIcon');
        if (icon) icon.textContent = t === 'light' ? '\u2600' : '\u263E';
    }

    // Light is the default; dwThemeV2 forces it once, then the toggle sticks.
    try {
        if (!localStorage.getItem('dwThemeV2')) { localStorage.setItem(THEME_KEY, 'light'); localStorage.setItem('dwThemeV2', '1'); }
    } catch (e) { /* private mode: default below */ }
    applyTheme(localStorage.getItem(THEME_KEY) || 'light'); // immediate, no flash
    // account gate, see client/account/main.js. Framed on a portal: straight to guest play.
    var acctHint = localStorage.getItem('dwAcctHint') || 'new';
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

    /* ── Mobile / tablet gate ──────────────────────────────────────────
       The game needs keyboard + mouse, so touch-primary devices are blocked.
       "(hover: hover) and (pointer: fine)" is true on laptops (even touchscreen
       ones) and false on phones and bare iPads. iPadOS claims to be a Mac in
       its UA, so maxTouchPoints is used instead. The override is remembered. */
    var GATE_KEY = 'digwarsDesktopOverride';

    function isTouchOnlyDevice() {
        if (localStorage.getItem(GATE_KEY) === '1') return false;
        var precisePointer = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
        var touchCapable = navigator.maxTouchPoints > 1 ||
            /Android|webOS|iPhone|iPad|iPod|BlackBerry/i.test(navigator.userAgent);
        return touchCapable && !precisePointer;
    }

    function initMobileGate() {
        var gate = document.getElementById('mobileGate');
        if (!gate || !isTouchOnlyDevice()) return;

        gate.hidden = false;
        var override = document.getElementById('mobileGateOverride');
        if (override) override.onclick = function () {
            localStorage.setItem(GATE_KEY, '1');
            gate.hidden = true;
        };

        // Attaching a mouse or trackpad later flips the media query.
        var mq = window.matchMedia('(hover: hover) and (pointer: fine)');
        var onChange = function (e) { if (e.matches) gate.hidden = true; };
        if (mq.addEventListener) mq.addEventListener('change', onChange);
        else if (mq.addListener) mq.addListener(onChange); // older Safari
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
                        alert('All training grounds are in use right now - please try again in a minute.');
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
                    alert('The tutorial server is not reachable right now. Please try again in a moment.');
                });
        }, function () {
            if (btn) { btn.disabled = false; }
            alert('The game is still loading. Please wait a second and try again.');
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
                    alert('Corez.io 2TDM is not reachable right now. Please try again in a moment.');
                });
        }, function () {
            if (btn) { btn.disabled = false; }
            alert('The game is still loading. Please wait a second and try again.');
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

    document.addEventListener('DOMContentLoaded', function () {
        initMobileGate();
        initTutorialEntry();
        playAfterTutorial();
        // #dw no longer routes anywhere (Dig Wars is parked); drop a stale hash.
        if (location.hash === '#dw') { try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { location.hash = ''; } }

        applyTheme(localStorage.getItem(THEME_KEY) || 'dark');

        var fsBtn = document.getElementById('homeFullscreenBtn');
        if (fsBtn) {
            if (window.dwFullscreen.supported()) {
                fsBtn.hidden = false;
                fsBtn.onclick = function () { window.dwFullscreen.toggle(); fsBtn.blur(); };
            }
            syncFullscreenButtons();
        }

        var tb = document.getElementById('themeToggleBtn');
        if (tb) tb.onclick = function () {
            applyTheme(root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
        };

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
        if (ytSoon) ytSoon.onclick = function () { showToast('No YouTube yet. Maybe soon'); };

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

        var canvas = document.getElementById('snowCanvas');
        if (!canvas) return;
        var ctx = canvas.getContext('2d');
        var W = 0, H = 0, dpr = 1;
        var tanks = [];
        var homeFxOn = true;
        var homeFxRaf = 0;
        var reduceMotion = window.matchMedia &&
            window.matchMedia('(prefers-reduced-motion: reduce)').matches;

        // Same gun math as the game (LENGTH/10, trapezoid barrels), then an
        // opaque hull on top. The whole sprite is faded afterward so it is
        // translucent without barrels showing through the body.
        function G(length, width, aspect, x, y, angle) {
            var ox = x || 0, oy = y || 0;
            return {
                length: length / 10,
                width: width / 10,
                aspect: aspect == null ? 1 : aspect,
                angle: ((angle || 0) * Math.PI) / 180,
                offset: Math.hypot(ox, oy) / 10,
                direction: Math.atan2(oy, ox)
            };
        }
        function around(guns, count) {
            var out = [];
            for (var i = 0; i < count; i++) {
                var add = (Math.PI * 2 * i) / count;
                for (var j = 0; j < guns.length; j++) {
                    var g = guns[j];
                    out.push({
                        length: g.length, width: g.width, aspect: g.aspect,
                        angle: g.angle + add, offset: g.offset, direction: g.direction
                    });
                }
            }
            return out;
        }
        var TANK_KINDS = [
            { guns: [G(18, 8)] },
            { guns: [G(20, 8, 1, 0, 5.5), G(20, 8, 1, 0, -5.5)] },
            { guns: [G(19, 8, 1, 0, 2, 18), G(19, 8, 1, 0, -2, -18), G(22, 8)] },
            { guns: [G(24, 8)] },
            { guns: [G(12, 10, 1.4, 8, 0)] },
            { guns: around([G(18, 8)], 3) },
            { guns: around([G(18, 8)], 4) },
            { guns: [G(20.5, 12)] },
            { guns: [G(20.5, 14)] },
            { guns: [G(20.5, 19.5)] },
            { guns: around([G(18, 8, 1, 0, 0, 45), G(18, 8)], 4) },
            { guns: [G(15, 7), G(3, 7, 1.7, 15, 0)] },
            { guns: [G(5, 11, 1.3, 8, 0)] },
            { guns: [G(6, 12, 1.2, 8, 0, 90), G(6, 12, 1.2, 8, 0, -90)] },
            { guns: [G(12, 3.5, 1, 0, 7.25), G(16, 3.5, 1, 0, 3.75), G(16, 3.5, 1, 0, -3.75), G(12, 3.5, 1, 0, -7.25)] },
            { guns: [G(23, 7), G(12, 10, 1.4, 8, 0)] },
            { guns: [G(18, 8), G(16, 8, 1, 0, 0, 150), G(16, 8, 1, 0, 0, -150)] },
            { guns: [G(18, 8), G(14, 8, 1, 0, 0, 135), G(16, 8, 1, 0, 0, 150), G(14, 8, 1, 0, 0, -135), G(16, 8, 1, 0, 0, -150)] },
            { guns: [G(18, 8), G(16, 8, 1, 0, -1, 90), G(16, 8, 1, 0, 1, -90), G(16, 8, 1, 0, 0, 150), G(16, 8, 1, 0, 0, -150)] },
            { guns: [G(16, 8, 1, 0, 3, 30), G(16, 8, 1, 0, -3, -30), G(19, 8, 1, 0, 2, 15), G(19, 8, 1, 0, -2, -15), G(22, 8)] },
            { guns: [G(17.5, 8, 1, 0, 5.5), G(17.5, 8, 1, 0, -5.5), G(21, 8)] },
            { guns: [G(25, 8), G(23, 8), G(21, 8), G(19, 8), G(17, 8)] },
            { guns: [G(21, 8), G(19, 8), G(17, 8)] },
            { guns: [G(27, 8), G(13, 8, -2.2)] },
            { guns: [G(32, 8), G(13, 8, -2.2)] },
            { guns: around([G(20, 8, 1, 0, 5.5), G(20, 8, 1, 0, -5.5)], 3) },
            { guns: [], smasher: true }
        ];

        function tankPalette() {
            var s = getComputedStyle(root);
            var gun = (s.getPropertyValue('--tank-gun') || '#9a9288').trim();
            var keys = ['a', 'b', 'c', 'd', 'e'];
            var out = [];
            for (var i = 0; i < keys.length; i++) {
                var k = keys[i];
                out.push({
                    fill: (s.getPropertyValue('--tank-' + k) || '#4ec4e8').trim(),
                    stroke: (s.getPropertyValue('--tank-' + k + '-line') || '#142838').trim(),
                    gun: gun
                });
            }
            return out;
        }

        var spriteCache = {};

        function rebuildTanks() {
            spriteCache = {};
            tanks = [];
            var pal = tankPalette();
            var n = Math.max(10, Math.min(18, Math.round((W * H) / 70000)));
            for (var i = 0; i < n; i++) {
                var dir = Math.random() < 0.7 ? 1 : -1;
                tanks.push({
                    x: Math.random() * W,
                    y: (0.06 + Math.random() * 0.88) * H,
                    r: 28,
                    ang: Math.random() * Math.PI * 2,
                    spin: (0.006 + Math.random() * 0.022) * (Math.random() < 0.5 ? 1 : -1),
                    vx: dir * (1.15 + Math.random() * 1.7),
                    bob: 4 + Math.random() * 14,
                    bobT: Math.random() * Math.PI * 2,
                    bobS: 0.012 + Math.random() * 0.02,
                    a: (root.getAttribute('data-theme') === 'light' ? 0.34 : 0.30) + Math.random() * 0.12,
                    kind: TANK_KINDS[(Math.random() * TANK_KINDS.length) | 0],
                    pal: pal[i % pal.length],
                    key: i
                });
            }
        }

        function resize() {
            dpr = Math.min(window.devicePixelRatio || 1, 2);
            W = window.innerWidth;
            H = window.innerHeight;
            canvas.width = Math.max(1, Math.floor(W * dpr));
            canvas.height = Math.max(1, Math.floor(H * dpr));
            canvas.style.width = W + 'px';
            canvas.style.height = H + 'px';
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            rebuildTanks();
        }
        resize();
        window.addEventListener('resize', resize);
        new MutationObserver(function () { rebuildTanks(); }).observe(root, {
            attributes: true, attributeFilter: ['data-theme']
        });

        function drawArrasGun(c, size, g) {
            var length = size * g.length / 2;
            var height = size * g.width / 2;
            var h0 = g.aspect > 0 ? height * g.aspect : height;
            var h1 = g.aspect > 0 ? height : -height * g.aspect;
            var ang = g.direction + g.angle;
            var gx = size * g.offset * Math.cos(ang);
            var gy = size * g.offset * Math.sin(ang);
            var sinT = Math.sin(g.angle), cosT = Math.cos(g.angle);
            var pts = [[0, h1], [length * 2, h0], [length * 2, -h0], [0, -h1]];
            c.beginPath();
            for (var i = 0; i < 4; i++) {
                c.lineTo(pts[i][0] * cosT - pts[i][1] * sinT + gx,
                         pts[i][0] * sinT + pts[i][1] * cosT + gy);
            }
            c.closePath();
            c.fill();
            c.stroke();
        }

        function drawOpaqueTank(c, t) {
            var size = t.r, pal = t.pal, lw = Math.max(3.2, size * 0.2);
            c.lineJoin = 'round';
            c.lineCap = 'round';
            c.lineWidth = lw;
            c.strokeStyle = pal.stroke;
            c.fillStyle = pal.gun;
            var guns = t.kind.guns || [];
            for (var i = 0; i < guns.length; i++) drawArrasGun(c, size, guns[i]);
            // Same fill-then-stroke as the barrels so the hull outline is
            // not a thinner inner ring.
            c.fillStyle = pal.fill;
            c.beginPath();
            c.arc(0, 0, size, 0, Math.PI * 2);
            c.fill();
            c.stroke();
            if (t.kind.smasher) {
                var hr = size * 1.14;
                c.beginPath();
                for (var s = 0; s < 6; s++) {
                    var a = Math.PI / 6 + (Math.PI * 2 * s) / 6;
                    var x = Math.cos(a) * hr, y = Math.sin(a) * hr;
                    if (s) c.lineTo(x, y); else c.moveTo(x, y);
                }
                c.closePath();
                c.fillStyle = pal.stroke;
                c.fill();
                c.stroke();
                c.fillStyle = pal.fill;
                c.beginPath();
                c.arc(0, 0, size, 0, Math.PI * 2);
                c.fill();
                c.stroke();
            }
        }

        function tankSprite(t) {
            var id = t.key + ':' + t.pal.fill + ':' + t.r;
            if (spriteCache[id]) return spriteCache[id];
            var pad = Math.ceil(t.r * 3.2);
            var spr = document.createElement('canvas');
            spr.width = Math.max(1, Math.floor(pad * 2 * dpr));
            spr.height = spr.width;
            var sctx = spr.getContext('2d');
            sctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            sctx.translate(pad, pad);
            drawOpaqueTank(sctx, t);
            var out = { canvas: spr, pad: pad };
            spriteCache[id] = out;
            return out;
        }

        function tickTanks() {
            var pad = 110;
            for (var i = 0; i < tanks.length; i++) {
                var t = tanks[i];
                if (!reduceMotion) {
                    t.x += t.vx;
                    t.ang += t.spin;
                    t.bobT += t.bobS;
                }
                if (t.x > W + pad) t.x = -pad;
                else if (t.x < -pad) t.x = W + pad;
            }
        }

        function drawHomeFx() {
            homeFxRaf = 0;
            if (!homeFxOn) return;
            ctx.clearRect(0, 0, W, H);
            tickTanks();
            for (var i = 0; i < tanks.length; i++) {
                var t = tanks[i];
                var spr = tankSprite(t);
                ctx.save();
                ctx.globalAlpha = t.a;
                ctx.translate(t.x, t.y + Math.sin(t.bobT) * t.bob);
                ctx.rotate(t.ang);
                ctx.drawImage(spr.canvas, -spr.pad, -spr.pad, spr.pad * 2, spr.pad * 2);
                ctx.restore();
            }
            ctx.globalAlpha = 1;
            if (!reduceMotion) homeFxRaf = requestAnimationFrame(drawHomeFx);
        }
        drawHomeFx();

        var homeUI = [
            document.getElementById('themeToggleBtn'),
            document.getElementById('homeSettingsBtn'),
            document.getElementById('homeChangelogBtn'),
            document.getElementById('homeSidebar'),
            document.getElementById('snowCanvas'),
            document.getElementById('homeFireworkCanvas')
        ];
        var smw = document.getElementById('startMenuWrapper');
        if (smw) {
            new MutationObserver(function () {
                var hidden = smw.style.display === 'none' || parseInt(smw.style.top) < -100;
                homeUI.forEach(function (el) { if (el) el.style.display = hidden ? 'none' : ''; });
                // mark in-game so the shared settings panel keeps its dark,
                // unchangeable look while playing (homepage follows the theme)
                document.body.classList.toggle('in-game', hidden);
                if (hidden) { closeCL(); closeP(); setDropdownOpen(false); }
                homeFxOn = !hidden;
                if (homeFxOn && !homeFxRaf) drawHomeFx();
                else if (!homeFxOn && homeFxRaf) {
                    cancelAnimationFrame(homeFxRaf);
                    homeFxRaf = 0;
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
