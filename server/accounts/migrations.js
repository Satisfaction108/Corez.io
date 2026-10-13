// Schema migrations, tracked with PRAGMA user_version.
//
// Each version runs in its own transaction together with the user_version
// bump, so a crash mid-migration leaves the previous version intact. Before
// touching an existing, non-empty database a VACUUM INTO copy is written to
// <backupDir>/pre-migrate-v{n}-{ts}.db.
//
// v1 already includes the ranked, dust, store, friends, quests and
// achievements tables. Times are epoch milliseconds; dust is integer
// milli-dust; days are UTC day numbers (floor(ms / 86400000)).
'use strict';

const fs = require('fs');
const path = require('path');

const V1 = `
CREATE TABLE users (
    id                  INTEGER PRIMARY KEY,
    public_id           TEXT    NOT NULL UNIQUE CHECK (length(public_id) = 11 AND substr(public_id, 1, 3) = 'DW-'),
    username            TEXT    NOT NULL,
    -- lower(username) while live; '#del:<id>' once soft-deleted so the unique
    -- slot frees up (username_holds keeps the name reserved for 30 days).
    username_lc         TEXT    NOT NULL UNIQUE,
    username_changed_at INTEGER NOT NULL DEFAULT 0,

    password_hash       TEXT,               -- 'scrypt$N$r$p$salt$hash', NULL = Discord-only
    recovery_hash       TEXT,               -- same format, over the normalised code
    discord_id          TEXT    UNIQUE,
    discord_name        TEXT,
    discord_avatar      TEXT,

    rp                  INTEGER NOT NULL DEFAULT 0 CHECK (rp >= 0),
    division            INTEGER NOT NULL DEFAULT 0 CHECK (division >= 0),   -- 0 = unranked / in placement
    peak_division       INTEGER NOT NULL DEFAULT 0 CHECK (peak_division >= 0),
    peak_rp             INTEGER NOT NULL DEFAULT 0 CHECK (peak_rp >= 0),
    placement_lives     INTEGER NOT NULL DEFAULT 0 CHECK (placement_lives >= 0),
    placement_basis     TEXT    NOT NULL DEFAULT '[]',                      -- JSON array of placement life bases
    placement_gain      INTEGER NOT NULL DEFAULT 0,
    ranked_at           INTEGER,
    legend_at           INTEGER,

    dust_milli          INTEGER NOT NULL DEFAULT 0 CHECK (dust_milli >= 0),
    earn_day            INTEGER NOT NULL DEFAULT 0,
    earn_day_milli      INTEGER NOT NULL DEFAULT 0 CHECK (earn_day_milli >= 0),
    refund_tokens       INTEGER NOT NULL DEFAULT 3 CHECK (refund_tokens >= 0),

    equip_name_style    TEXT,
    equip_skin          TEXT,
    custom_color        TEXT    CHECK (custom_color IS NULL OR (length(custom_color) = 7 AND custom_color GLOB '#[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]')),

    banned_until        INTEGER,
    ban_reason          TEXT,
    created_at          INTEGER NOT NULL,
    last_seen_at        INTEGER,
    deleted_at          INTEGER,
    CHECK (deleted_at IS NOT NULL OR username_lc = lower(username))
) STRICT;
CREATE INDEX users_rank    ON users(rp DESC) WHERE deleted_at IS NULL;
CREATE INDEX users_legend  ON users(rp DESC, legend_at) WHERE legend_at IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX users_deleted ON users(deleted_at) WHERE deleted_at IS NOT NULL;

CREATE TABLE username_holds (
    username_lc TEXT    NOT NULL PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reason      TEXT    NOT NULL CHECK (reason IN ('rename', 'delete', 'admin')),
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL
) STRICT;
CREATE INDEX username_holds_user    ON username_holds(user_id);
CREATE INDEX username_holds_expires ON username_holds(expires_at);

CREATE TABLE sessions (
    id           INTEGER PRIMARY KEY,
    token_hash   TEXT    NOT NULL UNIQUE,   -- hex sha256 of the cookie token
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    method       TEXT    NOT NULL,          -- signup | password | discord | recovery | reset
    created_at   INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    expires_at   INTEGER NOT NULL,
    reauth_until INTEGER NOT NULL DEFAULT 0,
    ip           TEXT,
    user_agent   TEXT
) STRICT;
CREATE INDEX sessions_user    ON sessions(user_id);
CREATE INDEX sessions_expires ON sessions(expires_at);

CREATE TABLE password_resets (
    token_hash TEXT    NOT NULL PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_by TEXT,                        -- admin Discord id, or 'system'
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at    INTEGER
) STRICT;
CREATE INDEX password_resets_user    ON password_resets(user_id);
CREATE INDEX password_resets_expires ON password_resets(expires_at);

-- One row per ranked life: opened at spawn, settled exactly once with
-- UPDATE ... WHERE ended_at IS NULL.
CREATE TABLE rank_lives (
    life_id        TEXT    NOT NULL PRIMARY KEY,
    user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    raid_key       TEXT    NOT NULL,
    server_id      TEXT,
    rules_version  INTEGER NOT NULL DEFAULT 1,
    started_at     INTEGER NOT NULL,
    ended_at       INTEGER,
    end_reason     TEXT    CHECK (end_reason IS NULL OR end_reason IN ('death', 'raid_end', 'disconnect', 'shutdown', 'crash')),
    basis_start    INTEGER NOT NULL DEFAULT 0,  -- basisOf() snapshot at life start
    raid_pts_start INTEGER NOT NULL DEFAULT 0,  -- account's raid points before this life (diminishing returns)
    basis          INTEGER,                     -- points this life counted
    gain           INTEGER,
    fare           INTEGER,
    delta          INTEGER,
    rp_before      INTEGER NOT NULL,
    rp_after       INTEGER,
    div_before     INTEGER NOT NULL,
    div_after      INTEGER,
    placement      INTEGER NOT NULL DEFAULT 0 CHECK (placement IN (0, 1)),
    kills          INTEGER NOT NULL DEFAULT 0,
    bot_kills      INTEGER NOT NULL DEFAULT 0,
    dust_milli     INTEGER NOT NULL DEFAULT 0,
    CHECK (ended_at IS NULL OR ended_at >= started_at)
) STRICT;
CREATE INDEX rank_lives_user ON rank_lives(user_id, started_at);
CREATE INDEX rank_lives_open ON rank_lives(user_id) WHERE ended_at IS NULL;
CREATE INDEX rank_lives_raid ON rank_lives(raid_key);

CREATE TABLE raid_results (
    raid_key   TEXT    NOT NULL,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    place      INTEGER NOT NULL CHECK (place >= 1),
    board_rows INTEGER NOT NULL CHECK (board_rows >= 1),
    score      INTEGER NOT NULL DEFAULT 0,
    raid_ms    INTEGER NOT NULL DEFAULT 0,      -- time spent in the raid
    rp_bonus   INTEGER NOT NULL DEFAULT 0,
    dust_milli INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (raid_key, user_id)
) STRICT;
CREATE INDEX raid_results_user ON raid_results(user_id, created_at);

-- Every balance change. balance_milli is the balance after the change.
CREATE TABLE dust_ledger (
    id            INTEGER PRIMARY KEY,
    user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    delta_milli   INTEGER NOT NULL,
    balance_milli INTEGER NOT NULL CHECK (balance_milli >= 0),
    kind          TEXT    NOT NULL CHECK (kind IN ('gems', 'kill', 'placement', 'quest', 'purchase', 'refund', 'gift', 'admin', 'other')),
    ref           TEXT,
    created_at    INTEGER NOT NULL
) STRICT;
CREATE INDEX dust_ledger_user ON dust_ledger(user_id, id);

CREATE TABLE purchases (
    id           INTEGER PRIMARY KEY,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,   -- buyer
    idem_key     TEXT    NOT NULL,
    item_id      TEXT    NOT NULL,
    price_milli  INTEGER NOT NULL CHECK (price_milli >= 0),
    day          INTEGER NOT NULL,                                          -- rotation day it was bought from
    is_gift      INTEGER NOT NULL DEFAULT 0 CHECK (is_gift IN (0, 1)),      -- stays 1 even if the recipient is deleted
    recipient_id INTEGER REFERENCES users(id) ON DELETE SET NULL,           -- gift recipient
    gift_message INTEGER,                                                   -- preset index, gifts only
    created_at   INTEGER NOT NULL,
    refunded_at  INTEGER,
    result       TEXT,                                                      -- JSON reply, replayed on a repeated idem_key
    UNIQUE (user_id, idem_key),
    CHECK (is_gift = 1 OR (recipient_id IS NULL AND gift_message IS NULL)),
    CHECK (refunded_at IS NULL OR is_gift = 0)                              -- gifts cannot be refunded
) STRICT;
CREATE INDEX purchases_user_time ON purchases(user_id, created_at);
CREATE INDEX purchases_recipient ON purchases(recipient_id) WHERE recipient_id IS NOT NULL;

CREATE TABLE owned_items (
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    item_id     TEXT    NOT NULL,
    source      TEXT    NOT NULL CHECK (source IN ('purchase', 'gift', 'admin', 'grant')),
    purchase_id INTEGER REFERENCES purchases(id) ON DELETE SET NULL,
    acquired_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, item_id)
) STRICT;

-- One row per UTC day, so the rotation stays fixed once computed.
CREATE TABLE shop_rotations (
    day        INTEGER PRIMARY KEY,
    featured   TEXT    NOT NULL,     -- JSON array of item ids
    daily      TEXT    NOT NULL,     -- JSON array of item ids
    created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE friendships (
    user_lo    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    user_hi    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_lo, user_hi),
    CHECK (user_lo < user_hi)
) STRICT;
CREATE INDEX friendships_hi ON friendships(user_hi);

CREATE TABLE friend_requests (
    from_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    to_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    silent     INTEGER NOT NULL DEFAULT 0 CHECK (silent IN (0, 1)),   -- recipient blocked the sender: never shown to them
    PRIMARY KEY (from_id, to_id),
    CHECK (from_id <> to_id)
) STRICT;
CREATE INDEX friend_requests_to ON friend_requests(to_id);

CREATE TABLE blocks (
    blocker_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    blocked_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (blocker_id, blocked_id),
    CHECK (blocker_id <> blocked_id)
) STRICT;
CREATE INDEX blocks_blocked ON blocks(blocked_id);

CREATE TABLE user_stats (
    user_id           INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    lives             INTEGER NOT NULL DEFAULT 0,
    kills             INTEGER NOT NULL DEFAULT 0,
    bot_kills         INTEGER NOT NULL DEFAULT 0,
    deaths            INTEGER NOT NULL DEFAULT 0,
    raids             INTEGER NOT NULL DEFAULT 0,
    raid_wins         INTEGER NOT NULL DEFAULT 0,
    top3              INTEGER NOT NULL DEFAULT 0,
    gems_banked       INTEGER NOT NULL DEFAULT 0,
    dust_earned_milli INTEGER NOT NULL DEFAULT 0,
    best_life         INTEGER NOT NULL DEFAULT 0,
    play_ms           INTEGER NOT NULL DEFAULT 0,
    updated_at        INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE TABLE user_achievements (
    user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    achievement_id TEXT    NOT NULL,
    progress       INTEGER NOT NULL DEFAULT 0,
    unlocked_at    INTEGER,
    PRIMARY KEY (user_id, achievement_id)
) STRICT;

CREATE TABLE daily_quests (
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    day          INTEGER NOT NULL,
    slot         INTEGER NOT NULL CHECK (slot BETWEEN 0 AND 2),
    quest_id     TEXT    NOT NULL,
    target       INTEGER NOT NULL CHECK (target > 0),
    progress     INTEGER NOT NULL DEFAULT 0 CHECK (progress >= 0),
    reward_milli INTEGER NOT NULL CHECK (reward_milli >= 0),
    completed_at INTEGER,
    claimed_at   INTEGER,
    PRIMARY KEY (user_id, day, slot)
) STRICT;

CREATE TABLE audit_log (
    id      INTEGER PRIMARY KEY,
    at      INTEGER NOT NULL,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    actor   TEXT    NOT NULL DEFAULT 'self',   -- self | system | admin:<discord id>
    action  TEXT    NOT NULL,
    detail  TEXT,                              -- JSON
    ip      TEXT
) STRICT;
CREATE INDEX audit_log_user   ON audit_log(user_id, at);
CREATE INDEX audit_log_action ON audit_log(action, at);

CREATE TABLE meta (
    key   TEXT NOT NULL PRIMARY KEY,
    value TEXT
) STRICT;
`;

// v2: direct messages between friends. The pair index is on (lower id,
// higher id, at) so one conversation reads in order; routes/friends.js keeps
// at most the last 200 per pair.
const V2 = `
CREATE TABLE friend_messages (
    id      INTEGER PRIMARY KEY,
    from_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    to_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body    TEXT    NOT NULL CHECK (length(body) BETWEEN 1 AND 300),
    at      INTEGER NOT NULL,
    read_at INTEGER,
    CHECK (from_id <> to_id)
) STRICT;
CREATE INDEX friend_messages_pair   ON friend_messages(min(from_id, to_id), max(from_id, to_id), at);
CREATE INDEX friend_messages_unread ON friend_messages(to_id, from_id) WHERE read_at IS NULL;
CREATE INDEX friend_messages_from   ON friend_messages(from_id);
`;

// v3: guests. One row per browser (a random id kept in localStorage), so the
// admin commands can see who plays without an account. No IP, no cookie tie;
// converted_user_id is set when that browser later plays logged in.
const V3 = `
CREATE TABLE guests (
    guest_id          TEXT    NOT NULL PRIMARY KEY CHECK (length(guest_id) = 32),
    name              TEXT,
    first_seen        INTEGER NOT NULL,
    last_seen         INTEGER NOT NULL,
    visits            INTEGER NOT NULL DEFAULT 0,
    games             INTEGER NOT NULL DEFAULT 0,
    kills             INTEGER NOT NULL DEFAULT 0,
    bot_kills         INTEGER NOT NULL DEFAULT 0,
    best_score        INTEGER NOT NULL DEFAULT 0,
    total_score       INTEGER NOT NULL DEFAULT 0,
    play_ms           INTEGER NOT NULL DEFAULT 0,
    converted_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    converted_at      INTEGER
) STRICT;
CREATE INDEX guests_last_seen ON guests(last_seen);
CREATE INDEX guests_converted ON guests(converted_user_id) WHERE converted_user_id IS NOT NULL;
`;

// v4: invites. One stable code per account (made the first time it is
// asked for), one referral row per account created from an invite link, and
// one reward row per milestone so each reward is granted exactly once.
// ip_hash is an HMAC of the referee's sign-up address (IPv6 by /64), never the
// address itself; the partial unique index allows one counted invite per
// address. referee_id is SET NULL on purge so the referrer's count holds.
//
// dust_ledger gains the 'referral' kind. SQLite cannot alter a CHECK, so the
// table is rebuilt: nothing references it and it has no triggers, so a copy,
// drop and rename inside this migration's transaction is safe (row ids kept).
const V4 = `
CREATE TABLE invite_codes (
    user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    code       TEXT    NOT NULL UNIQUE CHECK (length(code) = 7),
    created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE referrals (
    id           INTEGER PRIMARY KEY,
    referrer_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    referee_id   INTEGER UNIQUE REFERENCES users(id) ON DELETE SET NULL,
    code         TEXT    NOT NULL,
    method       TEXT    NOT NULL CHECK (method IN ('password', 'discord')),
    status       TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'qualified', 'rejected')),
    reason       TEXT,                      -- rejected: same_device | same_network | ip_used | expired
    ip_hash      TEXT    NOT NULL,
    created_at   INTEGER NOT NULL,
    decided_at   INTEGER,
    reward_milli INTEGER NOT NULL DEFAULT 0 CHECK (reward_milli >= 0),
    CHECK (referee_id IS NULL OR referee_id <> referrer_id),
    CHECK ((status = 'pending') = (decided_at IS NULL))
) STRICT;
CREATE INDEX referrals_referrer ON referrals(referrer_id, created_at);
CREATE INDEX referrals_pending  ON referrals(created_at) WHERE status = 'pending';
CREATE UNIQUE INDEX referrals_ip_once ON referrals(ip_hash) WHERE status = 'qualified';

CREATE TABLE referral_rewards (
    user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    tier     TEXT    NOT NULL CHECK (tier IN ('name_style', 'custom_skin')),
    at       INTEGER NOT NULL,
    PRIMARY KEY (user_id, tier)
) STRICT;

CREATE TABLE dust_ledger_v4 (
    id            INTEGER PRIMARY KEY,
    user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    delta_milli   INTEGER NOT NULL,
    balance_milli INTEGER NOT NULL CHECK (balance_milli >= 0),
    kind          TEXT    NOT NULL CHECK (kind IN ('gems', 'kill', 'placement', 'quest', 'purchase', 'refund', 'gift', 'admin', 'referral', 'other')),
    ref           TEXT,
    created_at    INTEGER NOT NULL
) STRICT;
INSERT INTO dust_ledger_v4 (id, user_id, delta_milli, balance_milli, kind, ref, created_at)
    SELECT id, user_id, delta_milli, balance_milli, kind, ref, created_at FROM dust_ledger;
DROP TABLE dust_ledger;
ALTER TABLE dust_ledger_v4 RENAME TO dust_ledger;
CREATE INDEX dust_ledger_user ON dust_ledger(user_id, id);
`;

// v5: play and win streaks (streaks.js). play_day is the UTC day number of
// the last counted life; win_raid the last raid key that moved the win
// streak, so a raid can't move it twice. win_day / win_day_milli hold the
// win dust paid today (daily cap).
//
// dust_ledger gains 'streak_play' and 'streak_win', rebuilt the same way as v4.
const V5 = `
CREATE TABLE user_streaks (
    user_id       INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    play_cur      INTEGER NOT NULL DEFAULT 0 CHECK (play_cur >= 0),
    play_best     INTEGER NOT NULL DEFAULT 0 CHECK (play_best >= 0),
    play_day      INTEGER NOT NULL DEFAULT 0,
    win_cur       INTEGER NOT NULL DEFAULT 0 CHECK (win_cur >= 0),
    win_best      INTEGER NOT NULL DEFAULT 0 CHECK (win_best >= 0),
    win_raid      TEXT,
    win_day       INTEGER NOT NULL DEFAULT 0,
    win_day_milli INTEGER NOT NULL DEFAULT 0 CHECK (win_day_milli >= 0),
    updated_at    INTEGER NOT NULL
) STRICT;

CREATE TABLE dust_ledger_v5 (
    id            INTEGER PRIMARY KEY,
    user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    delta_milli   INTEGER NOT NULL,
    balance_milli INTEGER NOT NULL CHECK (balance_milli >= 0),
    kind          TEXT    NOT NULL CHECK (kind IN ('gems', 'kill', 'placement', 'quest', 'purchase', 'refund', 'gift', 'admin', 'referral', 'streak_play', 'streak_win', 'other')),
    ref           TEXT,
    created_at    INTEGER NOT NULL
) STRICT;
INSERT INTO dust_ledger_v5 (id, user_id, delta_milli, balance_milli, kind, ref, created_at)
    SELECT id, user_id, delta_milli, balance_milli, kind, ref, created_at FROM dust_ledger;
DROP TABLE dust_ledger;
ALTER TABLE dust_ledger_v5 RENAME TO dust_ledger;
CREATE INDEX dust_ledger_user ON dust_ledger(user_id, id);
`;

// v6: death log (deaths.js). One row per human death in a raid, accounts
// and guests alike, so we can see what kills new players and how fast.
// cause is who did it; killer_name / killer_tank are the killer's name and
// class (bots and players) or the boss name; life_ms is how long that life
// lasted; life_no counts the lives of that connection (1 = first spawn).
const V6 = `
CREATE TABLE deaths (
    id          INTEGER PRIMARY KEY,
    at          INTEGER NOT NULL,
    user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
    guest_id    TEXT,
    server_id   TEXT,
    cause       TEXT    NOT NULL CHECK (cause IN ('bot', 'player', 'boss', 'storm', 'other')),
    killer_name TEXT,
    killer_tank TEXT,
    life_ms     INTEGER NOT NULL DEFAULT 0 CHECK (life_ms >= 0),
    life_no     INTEGER NOT NULL DEFAULT 0,
    newbie      INTEGER NOT NULL DEFAULT 0 CHECK (newbie IN (0, 1))
) STRICT;
CREATE INDEX deaths_at ON deaths(at);
`;

// v7: where a guest first came from, so we can see which game portals send
// players. Only a site name ("iogames.space", "embed:itch.io" when the game
// was shown in that site's iframe, "direct"), never a full URL.
const V7 = `
ALTER TABLE guests ADD COLUMN source TEXT;
`;

// v8: player feedback from the menu's Feedback button (feedback.js). One row
// per message, accounts and guests alike. No IP is kept (rate limits live in
// memory only); context is the small JSON the client attached, if any.
const V8 = `
CREATE TABLE feedback (
    id       INTEGER PRIMARY KEY,
    at       INTEGER NOT NULL,
    user_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
    guest_id TEXT    CHECK (guest_id IS NULL OR length(guest_id) = 32),
    category TEXT    CHECK (category IS NULL OR category IN ('bug', 'idea', 'balance', 'other')),
    text     TEXT    NOT NULL CHECK (length(text) BETWEEN 1 AND 1000),
    context  TEXT    NOT NULL DEFAULT '{}'
) STRICT;
CREATE INDEX feedback_at ON feedback(at);
`;

// v9: save codes and the persistent bank.
//
// saves: one row per "Save & leave" (saves.js). Only a hash of the code is
// kept. data is the saved tank as JSON (class, skills, growth, satchel, kit,
// gear, sidearm, raid points). A code works once (used_at) and runs out at
// expires_at. used_ip holds a salted hash of the restorer's IP for the
// one-restore-per-10-minutes rule and is cleared after a day.
//
// bank_gems: banked gems that outlast a raid (banks.js), on the account for
// players with one and on the guest row (keyed by the browser's guest id)
// for everyone else. While someone plays, their bank sits in a lease row
// (taken out of bank_gems in one transaction), so two tabs can never both
// spend it; held is the last checkpoint, written back if a crash leaves the
// lease behind.
const V9 = `
CREATE TABLE saves (
    id            INTEGER PRIMARY KEY,
    code_hash     TEXT    NOT NULL UNIQUE,
    mode          TEXT    NOT NULL CHECK (mode IN ('solo', 'duo')),
    user_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
    guest_id      TEXT    CHECK (guest_id IS NULL OR length(guest_id) = 32),
    data          TEXT    NOT NULL,
    score         INTEGER NOT NULL DEFAULT 0,
    created_at    INTEGER NOT NULL,
    expires_at    INTEGER NOT NULL,
    used_at       INTEGER,
    used_user_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
    used_guest_id TEXT,
    used_ip       TEXT
) STRICT;
CREATE INDEX saves_expires   ON saves(expires_at);
CREATE INDEX saves_used_user ON saves(used_user_id, used_at) WHERE used_user_id IS NOT NULL;
CREATE INDEX saves_used_gst  ON saves(used_guest_id, used_at) WHERE used_guest_id IS NOT NULL;
CREATE INDEX saves_used_ip   ON saves(used_ip, used_at) WHERE used_ip IS NOT NULL;

ALTER TABLE users ADD COLUMN bank_gems INTEGER NOT NULL DEFAULT 0 CHECK (bank_gems >= 0);
ALTER TABLE guests ADD COLUMN bank_gems INTEGER NOT NULL DEFAULT 0 CHECK (bank_gems >= 0);

CREATE TABLE bank_leases (
    lease_id      TEXT    NOT NULL PRIMARY KEY,
    owner         TEXT    NOT NULL CHECK (substr(owner, 1, 2) IN ('a:', 'g:')),
    taken         INTEGER NOT NULL DEFAULT 0 CHECK (taken >= 0),
    held          INTEGER NOT NULL DEFAULT 0 CHECK (held >= 0),
    at            INTEGER NOT NULL,
    recovered     INTEGER,
    recovered_at  INTEGER
) STRICT;
CREATE INDEX bank_leases_owner ON bank_leases(owner);
CREATE INDEX bank_leases_at    ON bank_leases(at);
`;

// v10: sidekicks (store.js). The equipped sidekick, its skin and name style
// sit next to the other equip_* columns; sidekick_name is the Locker name
// (cleaned and checked, NULL = the sidekick's own name) and sidekick_color
// one of the Locker swatches (NULL = its own colour). shop_rotations gets the
// day's Sidekicks shelf as a JSON array of ids; NULL on days stored before
// this, filled in the first time that day is read.
const V10 = `
ALTER TABLE users ADD COLUMN equip_sidekick TEXT;
ALTER TABLE users ADD COLUMN equip_sd_skin TEXT;
ALTER TABLE users ADD COLUMN equip_sd_name TEXT;
ALTER TABLE users ADD COLUMN sidekick_name TEXT CHECK (sidekick_name IS NULL OR length(sidekick_name) BETWEEN 1 AND 16);
ALTER TABLE users ADD COLUMN sidekick_color TEXT CHECK (sidekick_color IS NULL OR (length(sidekick_color) = 7 AND sidekick_color GLOB '#[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'));
ALTER TABLE shop_rotations ADD COLUMN sidekicks TEXT;
`;

// v11: sidekicks, round 2. The novelty sidekicks, the face skins and the
// first sidekick name styles left the catalog (shared/cosmetics.js RETIRED
// keeps their names for old receipts). Whoever has one gets back what was
// paid for it, as dust, once:
//   bought   the purchase price, and the purchase is marked refunded so the
//            refund button can't pay it a second time
//   a gift   the price the friend paid, to whoever has it now (a gift can't
//            be marked refunded; the owned row going is what stops a repeat)
//   granted  nothing, it was free
// Each payout is a 'refund' ledger row (ref 'retired:<purchase id>') with the
// balance after it, plus an audit row. Equip slots holding one go back to
// empty, and every stored Sidekicks shelf is cleared so it's drawn again from
// the new catalog (store.js readRotation). The list is fixed here on purpose:
// this is what v11 retired, whatever the catalog says later.
const V11_RETIRED = [
    'sd_squint', 'sd_boxer', 'sd_pebble', 'sd_sprout', 'sd_bubbles', 'sd_chip', 'sd_prickles', 'sd_robo',
    'sd_frosty', 'sd_candy', 'sd_drillbit', 'sd_spooky', 'sd_shardy', 'sd_hothead', 'sd_clank', 'sd_buzz',
    'sd_majesty', 'sd_disco', 'sd_drako', 'sd_astro', 'sd_twinkle', 'sd_ember',
    'sds_shades', 'sds_sleepy', 'sds_blush', 'sds_hearts', 'sds_wink', 'sds_grumpy', 'sds_starry', 'sds_party',
    'sdn_bubble', 'sdn_lemonade', 'sdn_mint', 'sdn_berry', 'sdn_sunbeam', 'sdn_starlight',
];
function v11(db, now = Date.now()) {
    const ids = V11_RETIRED, marks = ids.map(() => '?').join(', ');
    const rows = db.all(`SELECT o.user_id, o.item_id, o.source, p.id AS pid, p.price_milli, p.is_gift, p.refunded_at
                         FROM owned_items o LEFT JOIN purchases p ON p.id = o.purchase_id
                         WHERE o.item_id IN (${marks}) ORDER BY o.user_id, o.item_id`, ...ids);
    for (const r of rows) {
        const paid = r.pid != null && r.refunded_at == null && (r.source === 'purchase' || r.source === 'gift');
        const pay = paid ? Math.max(0, r.price_milli | 0) : 0;
        if (pay > 0) {
            db.run('UPDATE users SET dust_milli = dust_milli + ? WHERE id = ?', pay, r.user_id);
            const bal = db.get('SELECT dust_milli FROM users WHERE id = ?', r.user_id);
            db.run("INSERT INTO dust_ledger (user_id, delta_milli, balance_milli, kind, ref, created_at) VALUES (?, ?, ?, 'refund', ?, ?)",
                r.user_id, pay, bal.dust_milli, 'retired:' + r.pid, now);
            db.run("INSERT INTO audit_log (at, user_id, actor, action, detail) VALUES (?, ?, 'system', 'store_retired_refund', ?)",
                now, r.user_id, JSON.stringify({ itemId: r.item_id, purchaseId: r.pid, priceMilli: pay, source: r.source }));
        }
        if (r.pid != null && !r.is_gift && r.refunded_at == null) db.run('UPDATE purchases SET refunded_at = ? WHERE id = ?', now, r.pid);
    }
    db.run(`DELETE FROM owned_items WHERE item_id IN (${marks})`, ...ids);
    for (const col of ['equip_sidekick', 'equip_sd_skin', 'equip_sd_name']) {
        db.run(`UPDATE users SET ${col} = NULL WHERE ${col} IN (${marks})`, ...ids);
    }
    db.run('UPDATE shop_rotations SET sidekicks = NULL');
}

// v12: the daily rewards track and web push (retention.js, push.js).
//
// daily_track: one row per account or guest browser (exactly one of user_id /
// guest_id). step is the last day claimed (1..7, 0 before the first claim),
// claims counts every claim ever (the double-claim guard: a claim only goes
// through as UPDATE ... WHERE claims = <what it read>), streak the claims in a
// row without a miss. owed holds the item ids a guest earned a "sign up to
// claim" for (JSON array). adopted_by is the account a guest track moved to
// when that browser signed up; the guest row is closed from then on.
// play_min is the UTC minute of the day this player usually shows up
// (smoothed), so a reminder lands around then.
//
// daily_claims: one row per claim, keyed (track, claim number), what it paid.
//
// push_subs: one row per browser push subscription (endpoint unique), owned
// by an account or a guest browser. daily_for is the track's claim count the
// last "reward ready" ping was about (one per claim cycle), daily_at when it
// went; last_event the last event id reminded about. fails / retry_at back
// off a push service that errors; a dead endpoint (404 / 410) is deleted.
//
// dust_ledger gains the 'daily' kind, rebuilt the same way as v4 and v5.
const V12 = `
CREATE TABLE daily_track (
    id            INTEGER PRIMARY KEY,
    user_id       INTEGER UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    guest_id      TEXT    UNIQUE CHECK (guest_id IS NULL OR length(guest_id) = 32),
    step          INTEGER NOT NULL DEFAULT 0 CHECK (step BETWEEN 0 AND 7),
    streak        INTEGER NOT NULL DEFAULT 0 CHECK (streak >= 0),
    best          INTEGER NOT NULL DEFAULT 0 CHECK (best >= 0),
    claims        INTEGER NOT NULL DEFAULT 0 CHECK (claims >= 0),
    last_claim_at INTEGER,
    owed          TEXT    NOT NULL DEFAULT '[]',
    adopted_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
    play_min      INTEGER CHECK (play_min IS NULL OR play_min BETWEEN 0 AND 1439),
    seen_at       INTEGER,
    created_at    INTEGER NOT NULL,
    CHECK ((user_id IS NULL) <> (guest_id IS NULL)),
    CHECK ((claims = 0) = (last_claim_at IS NULL))
) STRICT;

CREATE TABLE daily_claims (
    track_id   INTEGER NOT NULL REFERENCES daily_track(id) ON DELETE CASCADE,
    claim_no   INTEGER NOT NULL CHECK (claim_no >= 1),
    day        INTEGER NOT NULL CHECK (day BETWEEN 1 AND 7),
    at         INTEGER NOT NULL,
    gems       INTEGER NOT NULL DEFAULT 0 CHECK (gems >= 0),
    dust_milli INTEGER NOT NULL DEFAULT 0 CHECK (dust_milli >= 0),
    item_id    TEXT,
    PRIMARY KEY (track_id, claim_no)
) STRICT;

CREATE TABLE push_subs (
    id         INTEGER PRIMARY KEY,
    endpoint   TEXT    NOT NULL UNIQUE CHECK (length(endpoint) BETWEEN 20 AND 1024),
    p256dh     TEXT    NOT NULL CHECK (length(p256dh) BETWEEN 80 AND 100),
    auth       TEXT    NOT NULL CHECK (length(auth) BETWEEN 16 AND 32),
    user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
    guest_id   TEXT    CHECK (guest_id IS NULL OR length(guest_id) = 32),
    daily      INTEGER NOT NULL DEFAULT 1 CHECK (daily IN (0, 1)),
    events     INTEGER NOT NULL DEFAULT 1 CHECK (events IN (0, 1)),
    created_at INTEGER NOT NULL,
    seen_at    INTEGER NOT NULL,
    sent_at    INTEGER,
    daily_for  INTEGER NOT NULL DEFAULT 0,
    daily_at   INTEGER NOT NULL DEFAULT 0,
    last_event TEXT,
    fails      INTEGER NOT NULL DEFAULT 0 CHECK (fails >= 0),
    retry_at   INTEGER NOT NULL DEFAULT 0,
    CHECK ((user_id IS NULL) <> (guest_id IS NULL))
) STRICT;
CREATE INDEX push_subs_user  ON push_subs(user_id) WHERE user_id IS NOT NULL;
CREATE INDEX push_subs_guest ON push_subs(guest_id) WHERE guest_id IS NOT NULL;

CREATE TABLE dust_ledger_v12 (
    id            INTEGER PRIMARY KEY,
    user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    delta_milli   INTEGER NOT NULL,
    balance_milli INTEGER NOT NULL CHECK (balance_milli >= 0),
    kind          TEXT    NOT NULL CHECK (kind IN ('gems', 'kill', 'placement', 'quest', 'purchase', 'refund', 'gift', 'admin', 'referral', 'streak_play', 'streak_win', 'daily', 'other')),
    ref           TEXT,
    created_at    INTEGER NOT NULL
) STRICT;
INSERT INTO dust_ledger_v12 (id, user_id, delta_milli, balance_milli, kind, ref, created_at)
    SELECT id, user_id, delta_milli, balance_milli, kind, ref, created_at FROM dust_ledger;
DROP TABLE dust_ledger;
ALTER TABLE dust_ledger_v12 RENAME TO dust_ledger;
CREATE INDEX dust_ledger_user ON dust_ledger(user_id, id);
`;

// v13: achievements for everyone (achievements.js, game/achHooks.js).
//
// user_achievements gains `data`: a small JSON value for the few that need
// more than a number (the tanks tried so far). guest_achievements is the
// same thing per guest browser, so a guest earns them too; when that browser
// signs up, its rows move onto the new account (achievements.adoptGuest) and
// the guest rows are deleted. Counter progress lives in rows whose id starts
// with 'c:' (unlocked_at stays NULL); every other row is one achievement.
// The partial indexes keep the rarity count (unlocks per achievement) cheap.
//
// dust_ledger gains the 'achievement' kind, rebuilt the same way as v12.
const V13 = `
ALTER TABLE user_achievements ADD COLUMN data TEXT;

CREATE TABLE guest_achievements (
    guest_id       TEXT    NOT NULL CHECK (length(guest_id) = 32),
    achievement_id TEXT    NOT NULL,
    progress       INTEGER NOT NULL DEFAULT 0,
    unlocked_at    INTEGER,
    data           TEXT,
    PRIMARY KEY (guest_id, achievement_id)
) STRICT;
CREATE INDEX user_achievements_unlocked  ON user_achievements(achievement_id) WHERE unlocked_at IS NOT NULL;
CREATE INDEX guest_achievements_unlocked ON guest_achievements(achievement_id) WHERE unlocked_at IS NOT NULL;

CREATE TABLE dust_ledger_v13 (
    id            INTEGER PRIMARY KEY,
    user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    delta_milli   INTEGER NOT NULL,
    balance_milli INTEGER NOT NULL CHECK (balance_milli >= 0),
    kind          TEXT    NOT NULL CHECK (kind IN ('gems', 'kill', 'placement', 'quest', 'purchase', 'refund', 'gift', 'admin', 'referral', 'streak_play', 'streak_win', 'daily', 'achievement', 'other')),
    ref           TEXT,
    created_at    INTEGER NOT NULL
) STRICT;
INSERT INTO dust_ledger_v13 (id, user_id, delta_milli, balance_milli, kind, ref, created_at)
    SELECT id, user_id, delta_milli, balance_milli, kind, ref, created_at FROM dust_ledger;
DROP TABLE dust_ledger;
ALTER TABLE dust_ledger_v13 RENAME TO dust_ledger;
CREATE INDEX dust_ledger_user ON dust_ledger(user_id, id);
`;

// v14: the visit funnel (funnel.js, client/funnel.js). One row per page
// visit: the random visit id the page made, the guest browser and/or the
// account, desktop or mobile, the site the browser first came from, whether
// it was this browser's first visit, and how far the visit got:
//   load_ms     the load event, ms from navigation start
//   home_ms     the menu on screen, ms from navigation start
//   ready_ms    Play able to start a game, ms from navigation start
//   play_ms     ms on the menu before Play (NULL: never pressed)
//   control_ms  the first spawn, ms from navigation start
//   min1        1 once the visit had a minute in control
//   left_ms     ms on the page when it closed without Play
//   auto_start  1 when the game started itself (a first-timer on a portal)
// No IP, no user agent. Rows go after 90 days (index.js sweep).
const V14 = `
CREATE TABLE funnel_visits (
    visit_id    TEXT    PRIMARY KEY CHECK (length(visit_id) = 32),
    guest_id    TEXT    CHECK (guest_id IS NULL OR length(guest_id) = 32),
    user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
    device      TEXT    NOT NULL CHECK (device IN ('desktop', 'mobile')),
    source      TEXT,
    first_visit INTEGER NOT NULL DEFAULT 0 CHECK (first_visit IN (0, 1)),
    auto_start  INTEGER NOT NULL DEFAULT 0 CHECK (auto_start IN (0, 1)),
    load_ms     INTEGER CHECK (load_ms IS NULL OR load_ms >= 0),
    home_ms     INTEGER CHECK (home_ms IS NULL OR home_ms >= 0),
    ready_ms    INTEGER CHECK (ready_ms IS NULL OR ready_ms >= 0),
    play_ms     INTEGER CHECK (play_ms IS NULL OR play_ms >= 0),
    control_ms  INTEGER CHECK (control_ms IS NULL OR control_ms >= 0),
    min1        INTEGER NOT NULL DEFAULT 0 CHECK (min1 IN (0, 1)),
    left_ms     INTEGER CHECK (left_ms IS NULL OR left_ms >= 0),
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
) STRICT;
CREATE INDEX funnel_visits_created ON funnel_visits(created_at);
`;

const V15 = `
ALTER TABLE users ADD COLUMN xp INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN level INTEGER NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN xp_day INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN xp_day_n INTEGER NOT NULL DEFAULT 0;

ALTER TABLE guests ADD COLUMN xp INTEGER NOT NULL DEFAULT 0;
ALTER TABLE guests ADD COLUMN level INTEGER NOT NULL DEFAULT 1;
ALTER TABLE guests ADD COLUMN xp_day INTEGER NOT NULL DEFAULT 0;
ALTER TABLE guests ADD COLUMN xp_day_n INTEGER NOT NULL DEFAULT 0;
ALTER TABLE guests ADD COLUMN xp_to INTEGER REFERENCES users(id) ON DELETE SET NULL;

CREATE TABLE level_grants (
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    level      INTEGER NOT NULL CHECK (level BETWEEN 2 AND 50),
    at         INTEGER NOT NULL,
    dust_milli INTEGER NOT NULL DEFAULT 0 CHECK (dust_milli >= 0),
    item_id    TEXT,
    PRIMARY KEY (user_id, level)
) STRICT;

CREATE TABLE owned_items_v15 (
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    item_id     TEXT    NOT NULL,
    source      TEXT    NOT NULL CHECK (source IN ('purchase', 'gift', 'admin', 'grant', 'level')),
    purchase_id INTEGER REFERENCES purchases(id) ON DELETE SET NULL,
    acquired_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, item_id)
) STRICT;
INSERT INTO owned_items_v15 (user_id, item_id, source, purchase_id, acquired_at)
    SELECT user_id, item_id, source, purchase_id, acquired_at FROM owned_items;
DROP TABLE owned_items;
ALTER TABLE owned_items_v15 RENAME TO owned_items;

CREATE TABLE dust_ledger_v15 (
    id            INTEGER PRIMARY KEY,
    user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    delta_milli   INTEGER NOT NULL,
    balance_milli INTEGER NOT NULL CHECK (balance_milli >= 0),
    kind          TEXT    NOT NULL CHECK (kind IN ('gems', 'kill', 'placement', 'quest', 'purchase', 'refund', 'gift', 'admin', 'referral', 'streak_play', 'streak_win', 'daily', 'achievement', 'level', 'other')),
    ref           TEXT,
    created_at    INTEGER NOT NULL
) STRICT;
INSERT INTO dust_ledger_v15 (id, user_id, delta_milli, balance_milli, kind, ref, created_at)
    SELECT id, user_id, delta_milli, balance_milli, kind, ref, created_at FROM dust_ledger;
DROP TABLE dust_ledger;
ALTER TABLE dust_ledger_v15 RENAME TO dust_ledger;
CREATE INDEX dust_ledger_user ON dust_ledger(user_id, id);
`;

const MIGRATIONS = [
    { version: 1, up(db) { db.exec(V1); } },
    { version: 2, up(db) { db.exec(V2); } },
    { version: 3, up(db) { db.exec(V3); } },
    { version: 4, up(db) { db.exec(V4); } },
    { version: 5, up(db) { db.exec(V5); } },
    { version: 6, up(db) { db.exec(V6); } },
    { version: 7, up(db) { db.exec(V7); } },
    { version: 8, up(db) { db.exec(V8); } },
    { version: 9, up(db) { db.exec(V9); } },
    { version: 10, up(db) { db.exec(V10); } },
    { version: 11, up(db) { v11(db); } },
    { version: 12, up(db) { db.exec(V12); } },
    { version: 13, up(db) { db.exec(V13); } },
    { version: 14, up(db) { db.exec(V14); } },
    { version: 15, up(db) { db.exec(V15); } },
];

function latestVersion() {
    return MIGRATIONS.reduce((v, m) => Math.max(v, m.version), 0);
}

function hasTables(db) {
    return !!db.get("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' LIMIT 1");
}

// Returns {from, to, applied:[versions], backup:path|null}. Throws (and the
// caller disables accounts) if the file is newer than this code.
function apply(db, opts = {}) {
    const from = db.userVersion();
    const latest = latestVersion();
    if (from > latest) {
        throw new Error(`database is at schema v${from} but this build only knows v${latest}; refusing to touch it`);
    }
    const pending = MIGRATIONS.filter(m => m.version > from).sort((a, b) => a.version - b.version);
    const result = { from, to: from, applied: [], backup: null };
    if (!pending.length) return result;

    if (hasTables(db)) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const dir = opts.backupDir || path.join(path.dirname(db.file), 'backups');
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        result.backup = db.backupTo(path.join(dir, `pre-migrate-v${pending[0].version}-${ts}.db`));
        console.log('[accounts] pre-migration backup written to ' + result.backup);
    }
    for (const m of pending) {
        db.tx(() => {
            m.up(db);
            db.exec(`PRAGMA user_version = ${m.version | 0}`);
        });
        result.applied.push(m.version);
        result.to = m.version;
        console.log(`[accounts] migrated database to schema v${m.version}`);
    }
    return result;
}

module.exports = { apply, latestVersion, MIGRATIONS, V11_RETIRED };
