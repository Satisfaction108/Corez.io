// CrazyGames SDK (Basic Launch): load it only when the game runs on their
// site (index.html sets window.dwPortal), then report loading and when the
// player is actually in a raid, so their stats and ad timing line up.
// Multiplayer: a duo party is a CrazyGames room (room id and invite param are
// the party code). Their invite button shows while it has a free slot, an
// invite link (or a join from their UI mid-session) drops the friend into
// that party, and an instant multiplayer start makes a party right away.
(function () {
    'use strict';
    if (window.dwPortal !== 'crazygames') return;
    var sdk = null, playing = false, loaded = false;
    var room = '', links = {}, booted = false, bootTries = 0;

    function game() { return sdk && sdk.game; }
    function safe(fn) { try { fn(); return true; } catch (e) { return false; /* the SDK never breaks the game */ } }
    function party() {
        var P = window.dwParty;
        return P && P.state ? P : null;
    }

    // party.js asks for this when the duo panel copies an invite. inviteLink
    // answers a string (the docs say a promise, so take either)
    window.dwPortalInvite = function (code) {
        if (!sdk || !code) return '';
        if (links[code]) return links[code];
        safe(function () {
            var out = game().inviteLink({ party: code });
            if (typeof out === 'string') links[code] = out;
            else if (out && out.then) out.then(function (u) { if (typeof u === 'string') links[code] = u; }, function () {});
        });
        return links[code] || '';
    };

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
            safe(function () { game().addJoinRoomListener(function (params) { joinFrom(params); }); });
        }).catch(function () { /* local or blocked: play on without it */ });
    };
    document.head.appendChild(s);

    function done() {
        if (loaded) return;
        loaded = true;
        safe(function () { game().loadingStop(); });
    }

    // CrazyGames username in the name box (an empty one) so friends know you
    function nameFromUser() {
        var u = sdk.user;
        if (!u || !u.isUserAccountAvailable || !u.getUser) return Promise.resolve();
        return Promise.resolve(u.getUser()).then(function (who) {
            var inp = document.getElementById('playerNameInput');
            if (who && who.username && inp && !inp.value.trim()) inp.value = String(who.username).slice(0, 48);
        }).catch(function () {});
    }

    function inviteCode(params) {
        var c = params && params.party;
        if (!c) safe(function () { c = game().getInviteParam('party'); });
        c = String(c || '').replace(/[\s-]/g, '').toUpperCase();
        return /^[A-Z0-9]{5}$/.test(c) ? c : '';
    }

    function joinFrom(params) {
        var code = inviteCode(params), P = party();
        if (!code || !P) return;
        nameFromUser().then(function () { return P.join(code); }).catch(function () {});
    }

    // once the menu's party state is in: an invite link joins that party, an
    // instant multiplayer start gets a fresh one (unless you're in one)
    function boot() {
        var P = party();
        if (booted || !P) return;
        if (!P.state().loaded && ++bootTries < 40) return;
        booted = true;
        var g = game(), code = '';
        safe(function () { code = inviteCode(g.inviteParams); });
        if (code) { joinFrom({ party: code }); return; }
        if (!g.isInstantMultiplayer) { nameFromUser(); return; }
        nameFromUser().then(function () {
            var st = P.state();
            if (st.party) P.openInvite();
            else return P.create();
        }).catch(function () {});
    }

    // the party as a room: joinable while there's a free slot (a full duo,
    // or none at all, and the invite button goes)
    function syncRoom() {
        var P = party(), p = P && P.state().party;
        var key = p && p.code ? p.code + (p.full ? ':full' : ':open') : '';
        if (key === room) return;
        var g = game(), ok;
        if (!p || !p.code) {
            safe(function () { g.hideInviteButton(); });
            ok = safe(function () { g.leftRoom(); });
        } else if (p.full) {
            safe(function () { g.hideInviteButton(); });
            ok = safe(function () { g.updateRoom({ roomId: p.code, isJoinable: false }); });
        } else {
            ok = safe(function () {
                g.updateRoom({ roomId: p.code, isJoinable: true, inviteParams: { party: p.code } });
                g.showInviteButton({ party: p.code });
            });
            window.dwPortalInvite(p.code);
        }
        // a throttled room call throws: try again on the next tick
        if (ok) room = key;
    }

    // in a raid and alive = gameplay; the menu, death card and loading = not
    function watch() {
        boot();
        syncRoom();
        var now = !!(window.dwPlaying && window.dwPlaying());
        if (now === playing) return;
        playing = now;
        safe(function () { now ? game().gameplayStart() : game().gameplayStop(); });
    }
})();
