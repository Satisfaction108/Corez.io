// The daily rewards track, the database side (rules and table in
// shared/daily.js; routes in routes/retention.js; schema v12).
//
// Owners: {kind:'a', id: user id} for accounts, {kind:'g', id: guest id}
// for a browser playing without one. Every claim runs in one transaction
// (BEGIN IMMEDIATE): read the track, evaluate it on the server's clock,
// move it with UPDATE ... WHERE claims = <what was read> (a second click, a
// second tab or a replayed request finds nothing to update), write the
// daily_claims row (its primary key is the same guard again), then pay:
//   gems  banks.credit, onto what is at rest (safe while a raid holds a lease)
//   dust  dust.creditExempt, ledger kind 'daily' (exempt from the soft cap,
//         like quest and streak dust)
//   items owned_items source 'grant', put on if that slot is empty; already
//         owned pays the day's fallback dust instead
// A guest's day 3 and day 7 items go on the track's `owed` list and are
// handed over by adoptGuest when that browser shows up logged in to a brand
// new account; the guest's progress on the track comes along too.
'use strict';

const db = require('./db');
const config = require('./config');
const banks = require('./banks');
const dust = require('./dust');
const users = require('./users');
const store = require('./store');
const C = require('../../shared/cosmetics.js');
const D = require('../../shared/daily.js');
const { HttpError } = require('./http');

const GUEST_RE = /^[a-f0-9]{32}$/;
const NEW_ACCOUNT_MS = 24 * 60 * 60 * 1000;
const RARITY = { common: 0, uncommon: 1, rare: 2, epic: 3, legendary: 4 };

function h() { return db.handle(); }
const on = () => !!config.retentionDaily;

function ownerKey(o) { return o.kind === 'a' ? 'a:' + o.id : 'g:' + o.id; }
function validOwner(o) {
    return !!o && ((o.kind === 'a' && Number.isInteger(o.id) && o.id > 0) || (o.kind === 'g' && GUEST_RE.test(String(o.id))));
}

function rowOf(d, o) {
    return o.kind === 'a'
        ? d.get('SELECT * FROM daily_track WHERE user_id = ?', o.id)
        : d.get('SELECT * FROM daily_track WHERE guest_id = ?', o.id);
}
function stateOf(row) {
    return row ? { step: row.step | 0, streak: row.streak | 0, best: row.best | 0, claims: row.claims | 0, lastClaimAt: row.last_claim_at } : null;
}
function owedOf(row) {
    try { const a = JSON.parse(row && row.owed || '[]'); return Array.isArray(a) ? a.filter(x => typeof x === 'string' && C.byId(x)) : []; } catch (e) { return []; }
}
function ownedOf(o) {
    return o.kind === 'a' ? store.ownedSet(o.id) : null;
}

// ── rewards ────────────────────────────────────────────────────────────
function itemView(id) {
    const it = id ? C.byId(id) : null;
    return it ? { id: it.id, name: it.name, cat: it.cat, rarity: it.rarity, nid: it.nid } : null;
}
// The item a day hands out for this owner: a fixed id, or for 'day7' the
// first skin the account doesn't own (a guest is shown the first).
function itemFor(entry, owned) {
    if (!entry.item) return null;
    if (entry.item !== 'day7') return entry.item;
    if (!owned) return D.DAY7_ITEMS[0];
    return D.DAY7_ITEMS.find(id => !owned.has(id)) || D.DAY7_ITEMS[0];
}
// What claiming `day` pays this owner. owned: the account's owned set, or
// null for a guest. -> {day, gems, dustMilli, item, signup}
//   item    {id, name, cat, rarity} | null
//   signup  true when the item only comes with an account (guests)
function rewardFor(day, owned) {
    const e = D.TRACK[Math.max(1, Math.min(D.DAYS, day | 0)) - 1];
    const id = itemFor(e, owned);
    if (!owned) return { day: e.day, gems: e.gems, dustMilli: 0, item: itemView(id), signup: !!id };
    if (id && owned.has(id)) return { day: e.day, gems: e.gems, dustMilli: e.dustMilli + (e.fallbackMilli | 0), item: null, signup: false, had: itemView(id) };
    return { day: e.day, gems: e.gems, dustMilli: e.dustMilli, item: itemView(id), signup: false };
}

// ── visits ─────────────────────────────────────────────────────────────
// An existing track notes the visit (last seen, usual time of day). A
// player with no track yet gets one on their first claim.
function touch(d, row, now) {
    if (!row) return;
    d.run('UPDATE daily_track SET seen_at = ?, play_min = ? WHERE id = ?', now, D.smoothMinute(row.play_min, D.minuteOf(now)), row.id);
}

// ── adoption ───────────────────────────────────────────────────────────
// A guest browser that just signed up: its track (and anything it is owed)
// moves onto the account, once. Only for an account made in the last day
// that has no track of its own yet, and a guest row nobody else converted.
// -> {moved: bool, items: [item views granted]}
function adoptGuest(userId, guestId, now = Date.now()) {
    const d = h();
    const none = { moved: false, items: [] };
    if (!d || !on() || !GUEST_RE.test(String(guestId || '')) || !Number.isInteger(userId)) return none;
    return d.tx(() => {
        const u = d.get('SELECT id, created_at, equip_sidekick, equip_sd_skin FROM users WHERE id = ? AND deleted_at IS NULL', userId);
        if (!u || u.created_at < now - NEW_ACCOUNT_MS) return none;
        if (d.get('SELECT 1 AS x FROM daily_track WHERE user_id = ?', userId)) return none;
        const g = d.get('SELECT * FROM daily_track WHERE guest_id = ? AND adopted_by IS NULL', guestId);
        if (!g || !(g.claims > 0)) return none;
        const conv = d.get('SELECT converted_user_id AS c FROM guests WHERE guest_id = ?', guestId);
        if (conv && conv.c != null && conv.c !== userId) return none;
        // the guest row closes first (adopted_by IS NULL is the once-only guard)
        if (!d.run('UPDATE daily_track SET adopted_by = ? WHERE id = ? AND adopted_by IS NULL', userId, g.id).changes) return none;
        d.run(`INSERT INTO daily_track (user_id, step, streak, best, claims, last_claim_at, play_min, seen_at, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, userId, g.step, g.streak, g.best, g.claims, g.last_claim_at, g.play_min, now, now);
        const items = [];
        for (const id of owedOf(g)) {
            if (grantItem(d, userId, id, now)) items.push(itemView(id));
        }
        users.audit(userId, 'daily_adopt', { guest: guestId.slice(0, 6), claims: g.claims, step: g.step, items: items.map(i => i.id) }, { now, actor: 'system' });
        return { moved: true, items };
    });
}

// Gives the account an item (inside the caller's transaction) and puts it on
// if that slot is empty. -> true if it was new
function grantItem(d, userId, itemId, now) {
    const it = C.byId(itemId);
    if (!it || it.retired) return false;
    const fresh = d.run("INSERT OR IGNORE INTO owned_items (user_id, item_id, source, purchase_id, acquired_at) VALUES (?, ?, 'grant', NULL, ?)",
        userId, it.id, now).changes > 0;
    if (!fresh) return false;
    const col = store.SLOT_COL[it.cat];
    if (col) {
        // a sidekick skin only goes on when there is a sidekick to wear it
        const extra = it.cat === 'sdSkin' || it.cat === 'sdName' ? ' AND equip_sidekick IS NOT NULL' : '';
        d.run(`UPDATE users SET ${col} = ? WHERE id = ? AND ${col} IS NULL${extra}`, it.id, userId);
    }
    return true;
}

// ── status ─────────────────────────────────────────────────────────────
// The shelf's best sidekick today, for the home screen. Never fails the
// status.
function shopPick(now) {
    try {
        const rot = store.rotationFor(store.dayOf(now), undefined, now);
        const kicks = (rot.sidekicks || []).map(id => C.byId(id)).filter(it => it && it.cat === 'sidekick');
        kicks.sort((a, b) => (RARITY[b.rarity] | 0) - (RARITY[a.rarity] | 0));
        const it = kicks[0];
        return it ? { id: it.id, name: it.name, rarity: it.rarity, price: it.price / C.MILLI } : null;
    } catch (e) { return null; }
}

// What the menu and the raid end show. Notes the visit when opts.touch.
// -> {on, owner, day, ready, readyAt, expiresAt, missed, from, streak, best,
//     claims, step, today, tomorrow, track:[7], owed:[items], adopted, bank,
//     shop, now}
function status(o, now = Date.now(), opts = {}) {
    if (!on()) return { on: false, now };
    const d = h();
    if (!d || !validOwner(o)) throw new HttpError(503, 'accounts_unavailable', 'Accounts are down rn. You can still play as a guest.');
    let row = rowOf(d, o);
    if (opts.touch && row) { touch(d, row, now); row = rowOf(d, o); }
    const st = stateOf(row);
    const ev = D.evaluate(st, now);
    const owned = ownedOf(o);
    const track = [];
    for (let i = 1; i <= D.DAYS; i++) track.push(rewardFor(i, owned));
    // the day after the next claim, for "Tomorrow: ..." once today is claimed
    const nextAfter = ev.ready ? D.nextDay(ev.day) : ev.day;
    return {
        on: true,
        owner: o.kind === 'a' ? 'account' : 'guest',
        day: ev.day,
        ready: ev.ready,
        readyAt: ev.readyAt,
        expiresAt: ev.expiresAt,
        missed: ev.missed,
        from: ev.from,
        streak: ev.missed ? 0 : (st ? st.streak : 0),
        best: st ? st.best : 0,
        claims: st ? st.claims : 0,
        step: st ? st.step : 0,
        today: rewardFor(ev.day, owned),
        tomorrow: rewardFor(nextAfter, owned),
        track,
        owed: row && o.kind === 'g' ? owedOf(row).map(itemView) : [],
        adopted: !!(row && row.adopted_by),
        bank: banks.peek(ownerKey(o)),
        shop: shopPick(now),
        now,
    };
}

// ── claiming ───────────────────────────────────────────────────────────
// -> {claimed: {day, gems, dustMilli, item, signup, had}, balanceMilli, status}
// Throws 409 not_ready (with readyAt) when it isn't time yet, 409
// already_claimed when another request just took it, 409 adopted when the
// guest track moved to an account.
function claim(o, now = Date.now(), opts = {}) {
    if (!on()) throw new HttpError(404, 'daily_off', 'Daily rewards are off rn.');
    const d = h();
    if (!d || !validOwner(o)) throw new HttpError(503, 'accounts_unavailable', 'Accounts are down rn. You can still play as a guest.');
    const res = d.tx(() => {
        let row = rowOf(d, o);
        if (row && row.adopted_by) throw new HttpError(409, 'adopted', 'Your streak moved to your account. Log in to claim it.');
        if (!row) {
            if (opts.onNewTrack) opts.onNewTrack();
            d.run(o.kind === 'a'
                ? 'INSERT INTO daily_track (user_id, created_at, seen_at, play_min) VALUES (?, ?, ?, ?)'
                : 'INSERT INTO daily_track (guest_id, created_at, seen_at, play_min) VALUES (?, ?, ?, ?)', o.id, now, now, D.minuteOf(now));
            row = rowOf(d, o);
        }
        const st = stateOf(row);
        const ev = D.evaluate(st, now);
        if (!ev.ready) throw new HttpError(409, 'not_ready', 'Not yet. Come back in ' + D.countdown(ev.readyAt - now) + '.', { readyAt: ev.readyAt });
        const next = D.afterClaim(st, ev, now);
        const moved = d.run(`UPDATE daily_track SET step = ?, streak = ?, best = ?, claims = ?, last_claim_at = ?, seen_at = ?, play_min = ?
                             WHERE id = ? AND claims = ?`,
            next.step, next.streak, next.best, next.claims, now, now, D.smoothMinute(row.play_min, D.minuteOf(now)), row.id, st.claims).changes;
        if (!moved) throw new HttpError(409, 'already_claimed', 'Already claimed!');
        const owned = ownedOf(o);
        const reward = rewardFor(ev.day, owned);
        // gems: into the bank (the account a converted guest became, if any)
        const gems = banks.credit(ownerKey(o), reward.gems, now) || 0;
        let dustMilli = 0, balanceMilli = null, itemId = null;
        if (o.kind === 'a') {
            if (reward.item) {
                if (grantItem(d, o.id, reward.item.id, now)) itemId = reward.item.id;
                else {
                    // it can't be granted after all (got it some other way): the fallback dust
                    reward.had = reward.item;
                    reward.item = null;
                    reward.dustMilli += D.TRACK[ev.day - 1].fallbackMilli | 0;
                }
            }
            if (reward.dustMilli > 0) {
                balanceMilli = dust.creditExempt(o.id, reward.dustMilli, 'daily', 'daily:' + next.claims, now);
                if (balanceMilli != null) dustMilli = reward.dustMilli;
            }
            users.audit(o.id, 'daily_claim', { day: ev.day, claim: next.claims, gems, dustMilli, item: itemId, missed: ev.missed }, { now, ip: opts.ip });
        } else if (reward.item) {
            const owed = owedOf(row);
            if (!owed.includes(reward.item.id)) owed.push(reward.item.id);
            d.run('UPDATE daily_track SET owed = ? WHERE id = ?', JSON.stringify(owed.slice(-4)), row.id);
        }
        d.run('INSERT INTO daily_claims (track_id, claim_no, day, at, gems, dust_milli, item_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
            row.id, next.claims, ev.day, now, gems, dustMilli, itemId || (reward.signup && reward.item ? reward.item.id : null));
        return {
            claimed: { day: ev.day, gems, dustMilli, item: reward.item, signup: reward.signup, had: reward.had || null, missed: ev.missed, from: ev.from },
            balanceMilli,
        };
    });
    return { ...res, status: status(o, now) };
}

module.exports = { NEW_ACCOUNT_MS, on, ownerKey, validOwner, rewardFor, status, claim, adoptGuest, grantItem, shopPick };
