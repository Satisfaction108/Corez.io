// Gemdust balances: the database side. Balances are integer milli-dust
// (users.dust_milli, CHECK >= 0) and every change writes a dust_ledger row
// carrying the balance after it.
//
// The game thread batches gem and kill dust per account (game/dustHooks.js)
// and writes it here in one transaction. The daily soft cap is applied when
// the dust is earned, from the per-account earn state loaded here, so the
// HUD balance and the database always agree: gem and kill dust past
// DAILY_SOFT_CAP_MILLI in one UTC day pays SOFT_CAP_RATE. Placement and
// quest dust are exempt.
'use strict';

const db = require('./db');
const R = require('../../shared/ranks.js');

const DAY = 24 * 60 * 60 * 1000;
const RATE_K = Math.round(R.SOFT_CAP_RATE * 1000);

function h() { return db.handle(); }
function dayOf(ms) { return Math.floor(ms / DAY); }

// -> {balance, day, earned} | null (no such live account)
function loadState(userId) {
    const d = h();
    if (!d) return null;
    const r = d.get('SELECT dust_milli, earn_day, earn_day_milli FROM users WHERE id = ? AND deleted_at IS NULL', userId);
    return r ? { balance: r.dust_milli | 0, day: r.earn_day | 0, earned: r.earn_day_milli | 0 } : null;
}

// Pure. `earned` is what the account grossed today before this amount.
// -> {creditK (thousandths of milli-dust), earned (after)}
function softCap(earned, grossMilli) {
    const gross = Math.max(0, grossMilli | 0);
    const room = Math.max(0, R.DAILY_SOFT_CAP_MILLI - Math.max(0, earned | 0));
    const full = Math.min(gross, room);
    return { creditK: full * 1000 + (gross - full) * RATE_K, earned: (earned | 0) + gross };
}

// One transaction for every account in `list`:
//   [{userId, gems, kill, day, earned, gemsBanked, ref}]
// gems/kill are milli-dust already past the soft cap. -> Map userId -> balance
// (accounts deleted meanwhile are skipped). Throws if the write fails; the
// caller keeps the dust pending and tries again.
function flush(list, now = Date.now()) {
    const d = h();
    const out = new Map();
    if (!d || !list.length) return out;
    d.tx(() => {
        for (const e of list) {
            const add = (e.gems | 0) + (e.kill | 0);
            const r = d.run('UPDATE users SET dust_milli = dust_milli + ?, earn_day = ?, earn_day_milli = ? WHERE id = ? AND deleted_at IS NULL',
                add, e.day | 0, Math.max(0, e.earned | 0), e.userId);
            if (!r.changes) continue;
            let balance = d.get('SELECT dust_milli FROM users WHERE id = ?', e.userId).dust_milli | 0;
            // one ledger row per kind, balance after each
            const kill = e.kill | 0, gems = e.gems | 0;
            if (gems) d.run('INSERT INTO dust_ledger (user_id, delta_milli, balance_milli, kind, ref, created_at) VALUES (?, ?, ?, ?, ?, ?)',
                e.userId, gems, balance - kill, 'gems', e.ref || null, now);
            if (kill) d.run('INSERT INTO dust_ledger (user_id, delta_milli, balance_milli, kind, ref, created_at) VALUES (?, ?, ?, ?, ?, ?)',
                e.userId, kill, balance, 'kill', e.ref || null, now);
            if (add || e.gemsBanked) {
                d.run('INSERT OR IGNORE INTO user_stats (user_id, updated_at) VALUES (?, ?)', e.userId, now);
                d.run('UPDATE user_stats SET dust_earned_milli = dust_earned_milli + ?, gems_banked = gems_banked + ?, updated_at = ? WHERE user_id = ?',
                    add, Math.max(0, e.gemsBanked | 0), now, e.userId);
            }
            out.set(e.userId, balance);
        }
    });
    return out;
}

// Exempt credit (placement, quests) inside the caller's transaction.
// -> balance after
function creditExempt(userId, milli, kind, ref, now = Date.now()) {
    const d = h();
    milli = Math.max(0, milli | 0);
    if (!milli) return null;
    const r = d.run('UPDATE users SET dust_milli = dust_milli + ? WHERE id = ? AND deleted_at IS NULL', milli, userId);
    if (!r.changes) return null;
    const balance = d.get('SELECT dust_milli FROM users WHERE id = ?', userId).dust_milli | 0;
    d.run('INSERT INTO dust_ledger (user_id, delta_milli, balance_milli, kind, ref, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        userId, milli, balance, kind, ref || null, now);
    d.run('INSERT OR IGNORE INTO user_stats (user_id, updated_at) VALUES (?, ?)', userId, now);
    d.run('UPDATE user_stats SET dust_earned_milli = dust_earned_milli + ?, updated_at = ? WHERE user_id = ?', milli, now, userId);
    return balance;
}

module.exports = { DAY, dayOf, loadState, softCap, flush, creditExempt };
