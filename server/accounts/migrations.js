// Schema migrations, tracked with PRAGMA user_version.
//
// Each version runs in its own transaction together with the user_version
// bump, so a crash mid-migration leaves the previous version intact. Before
// touching an existing, non-empty database a VACUUM INTO copy is written to
// <backupDir>/pre-migrate-v{n}-{ts}.db.
//
// v1 is the whole plan's schema, including the tables later phases fill
// (ranked, dust, store, friends, quests, achievements), so those phases add
// code, not schema churn. Times are epoch milliseconds; dust is integer
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

const MIGRATIONS = [
    { version: 1, up(db) { db.exec(V1); } },
    { version: 2, up(db) { db.exec(V2); } },
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

module.exports = { apply, latestVersion, MIGRATIONS };
