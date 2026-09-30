// Discord /dust, the game side: bank gems for a player who is in a raid
// here. bridge.js feeds it the bus messages; every raid server (solo on the
// main thread, Duos in its worker) gets them, so the main thread asks in two
// steps and only one server ever pays:
//
//   <- main {t:'adminGemsFind', reqId, userId, name}
//        userId for an account, else name (a guest, as shown in the raid)
//   -> main {t:'adminGemsFound', reqId, server, alive, dead, name, banked}
//        server is this thread's token; alive/dead count the matching sockets
//   <- main {t:'adminGemsGive', reqId, server, userId, name, amount}
//        only the server whose token it is acts
//   -> main {t:'adminGemsGiven', reqId, server, ok, reason, name, before, after}
//
// The gems go straight into the bank (socket.gemBanked) with a GEM resync
// for the HUD and a toast. They don't count on the raid board, so an admin
// gift never moves score or rank. The same amount is added to the player's
// growth score (dig_royale addGrowth): they grow as if they had earned those
// points, while board score and placement stay as they were.
'use strict';

const crypto = require('crypto');
const accounts = require('../index');

const TOKEN = crypto.randomBytes(6).toString('hex');
const MAX_GIVE = 1000000;
const MAX_BANK = 1e9;

function on() {
    return typeof Config !== 'undefined' && !!Config.dig_royale && !Config.tutorial;
}

function bodyOf(s) {
    return (s && s.player && s.player.body) || null;
}

function alive(s) {
    const b = bodyOf(s);
    return !!(b && b.socket === s && !(b.isDead && b.isDead()));
}

// The sockets here that the message means: the account's, or guests whose
// raid name matches (case-insensitive; a guest shown as "~name" matches
// "name" too).
function matches(manager, msg) {
    const out = [];
    if (!manager || !manager.clients) return out;
    const userId = msg.userId | 0;
    const want = String(msg.name || '').trim().toLowerCase();
    for (const s of manager.clients) {
        if (!s || s.terminated) continue;
        if (userId) {
            if (s.account && s.account.id === userId) out.push(s);
            continue;
        }
        if (s.account || !want) continue;
        const b = bodyOf(s);
        const n = String((b && b.name) || '').toLowerCase();
        if (n && (n === want || n === '~' + want)) out.push(s);
    }
    return out;
}

function send(msg) {
    try { accounts.bus.toMain(msg); } catch (e) { /* main gone */ }
}

function find(manager, msg) {
    const all = matches(manager, msg);
    const live = all.filter(alive);
    const pick = live[0] || all[0] || null;
    const b = bodyOf(pick);
    send({
        t: 'adminGemsFound', reqId: msg.reqId, server: TOKEN,
        alive: live.length, dead: all.length - live.length,
        name: b && b.name ? String(b.name) : (pick && pick.account ? pick.account.username : null),
        banked: pick ? (pick.gemBanked || 0) | 0 : 0,
    });
}

function give(manager, msg) {
    if (msg.server !== TOKEN) return;
    const done = (extra) => send({ t: 'adminGemsGiven', reqId: msg.reqId, server: TOKEN, ...extra });
    const amount = Math.floor(Number(msg.amount));
    if (!(amount >= 1 && amount <= MAX_GIVE)) return done({ ok: false, reason: 'amount' });
    const live = matches(manager, msg).filter(alive);
    if (!live.length) return done({ ok: false, reason: 'gone' });
    if (live.length > 1) return done({ ok: false, reason: 'ambiguous' });
    const s = live[0];
    const body = bodyOf(s);
    const gems = require('../../game/terrain/gems.js');
    const before = (s.gemBanked || 0) | 0;
    const after = gems.setBanked(body, Math.min(MAX_BANK, before + amount));
    gems.talkGems(body, 0);
    let grew = false, growth = null;
    try {
        // dig_royale sets it (growth rides on its raid stats)
        const addGrowth = global.royaleAddGrowth;
        const g0 = body.growthMult || 1;
        growth = typeof addGrowth === 'function' ? addGrowth(body, amount) : null;
        grew = growth != null;
        // the growth tick eases the size up from here; report where it's headed
        if (grew) growth = { from: +g0.toFixed(2), score: growth | 0 };
    } catch (e) { grew = false; }
    try { s.talk('m', 6000, `An admin sent you ${amount.toLocaleString('en-US')} gems.` + (grew ? ' You grew!' : '')); } catch (e) { /* closing */ }
    done({ ok: true, name: String(body.name || (s.account && s.account.username) || ''), before, after, grew, growth });
}

// -> true when the message was one of ours
function handle(manager, msg) {
    if (!msg || (msg.t !== 'adminGemsFind' && msg.t !== 'adminGemsGive')) return false;
    if (!on()) return true;
    try {
        if (msg.t === 'adminGemsFind') find(manager, msg);
        else give(manager, msg);
    } catch (e) {
        console.error('[accounts] admin gems failed: ' + ((e && e.stack) || e));
        if (msg.t === 'adminGemsGive' && msg.server === TOKEN) send({ t: 'adminGemsGiven', reqId: msg.reqId, server: TOKEN, ok: false, reason: 'error' });
    }
    return true;
}

module.exports = { handle, TOKEN, MAX_GIVE };
