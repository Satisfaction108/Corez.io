// Core lucky drop (Oct 6 2026): whoever lands the hit that breaks the Core
// (coreFinale.onBroken's killer, the Core Breaker achievement's player) has a
// CHANCE (ROYALE_CORE_DROP_CHANCE, default 0.2) to find a random lobby shop
// cosmetic they don't own yet.
//
// Pool: every catalog item that the lobby shop sells (shared/cosmetics.js):
// skins, name styles, sidekicks, sidekick skins and sidekick name styles,
// minus retired items, exclusive / achievement (`earn`) / invite rewards,
// free items and the starter Buddy. Every eligible item is equally likely
// (a flat pick: a legendary is as likely as a common, which is what makes
// it a lucky drop). Owns everything: no drop.
//
// Keeping it (accounts/game/bridge.js lootOwner/lootOwned/lootGrant): an
// account gets it at once (owned_items via retention.grantItem, in the
// Locker); a guest browser's drop waits in its guest_achievements loot row
// and is granted when it signs up (achievements.adoptGuest), like guest
// achievements. Nobody to keep it (accounts off, no guest id): no drop.
//
// Announced at the blast (coreFinale.blow), after the "YOU BROKE THE CORE"
// slam: KC 'coreloot' for the winner (a must-see slam) and a feed line for
// everyone ({cloot:1, by, item, rar}).
'use strict';

const C = require('../../../shared/cosmetics.js');

function chance() {
    const v = parseFloat(process.env.ROYALE_CORE_DROP_CHANCE);
    return isFinite(v) ? Math.max(0, Math.min(1, v)) : 0.2;
}

function eligible(it) {
    return !!it && !it.retired && !it.exclusive && !it.earn && it.price > 0 &&
        it.id !== C.BASIC_SIDEKICK_ID && it.id !== C.INVITE_STYLE_ID && C.isCat(it.cat);
}
const POOL = Object.freeze(C.ITEMS.filter(eligible));

// Pure: a random pool item not in `owned` (a Set of ids), or null
function pick(owned, rand = Math.random) {
    const left = owned && owned.size ? POOL.filter(it => !owned.has(it.id)) : POOL;
    if (!left.length) return null;
    return left[Math.floor(rand() * left.length) % left.length];
}

function rarityName(it) {
    const r = it && C.RARITIES[it.rarity];
    return r ? r.name : 'Common';
}

let bridge = null;   // tests swap it (setBridge)
function B() { return bridge || (bridge = require('../../accounts/game/bridge.js')); }
function setBridge(b) { bridge = b; }

// body: the Core breaker. hooks: {callout(body, kind, text, pts, sub, dur), feed(entry)}
// -> the item granted, or null
function onBreak(body, hooks = {}, rand = Math.random) {
    const socket = body && body.socket;
    if (!socket || socket.terminated) return null;
    if (!(rand() < chance())) return null;
    let item = null, guest = false;
    try {
        const b = B();
        const owner = b.lootOwner(socket);
        if (!owner) return null;
        item = pick(b.lootOwned(owner), rand);
        if (!item) return null;
        if (!b.lootGrant(owner, item.id)) return null;
        guest = owner.kind !== 'a';
    } catch (e) {
        console.error('[CORE LOOT]', e && e.message);
        return null;
    }
    const rar = rarityName(item);
    const sub = 'You got ' + item.name + ' (' + rar + ').' + (guest ? ' Sign up to keep it.' : ' It is in your Locker.');
    if (hooks.callout) hooks.callout(body, 'coreloot', 'CORE LOOT!', 0, sub, 5200);
    if (hooks.feed) hooks.feed({ cloot: 1, by: String(body.name || 'Someone'), item: item.name, rar: item.rarity });
    return item;
}

module.exports = { chance, eligible, POOL, pick, rarityName, onBreak, setBridge };
