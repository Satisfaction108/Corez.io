// CrazyGames SDK (Basic Launch): load it only when the game runs on their
// site (index.html sets window.dwPortal), then report loading and when the
// player is actually in a raid, so their stats and ad timing line up.
(function () {
    'use strict';
    if (window.dwPortal !== 'crazygames') return;
    var sdk = null, playing = false, loaded = false;

    function game() { return sdk && sdk.game; }
    function safe(fn) { try { fn(); } catch (e) { /* the SDK never breaks the game */ } }

    var s = document.createElement('script');
    s.src = 'https://sdk.crazygames.com/crazygames-sdk-v3.js';
    s.async = true;
    s.onload = function () {
        var S = window.CrazyGames && window.CrazyGames.SDK;
        if (!S || !S.init) return;
        Promise.resolve(S.init()).then(function () {
            sdk = S;
            safe(function () { game().loadingStart(); });
            if (document.readyState === 'complete') done();
            else window.addEventListener('load', done);
            setInterval(watch, 500);
        }).catch(function () { /* local or blocked: play on without it */ });
    };
    document.head.appendChild(s);

    function done() {
        if (loaded) return;
        loaded = true;
        safe(function () { game().loadingStop(); });
    }

    // in a raid and alive = gameplay; the menu, death card and loading = not
    function watch() {
        var g = window.royaleState ? window.royaleState() : null;
        var now = !!(g && g.gameStart && !g.died && !g.disconnected);
        if (now === playing) return;
        playing = now;
        safe(function () { now ? game().gameplayStart() : game().gameplayStop(); });
    }
})();
