// Print every live account (read-only): `node scripts/list-users.js`
// Guests have no row; they only live in their own browser.
'use strict';
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const file = process.argv[2] || path.join(__dirname, '..', 'data', 'digwars.db');
const db = new DatabaseSync(file, { readOnly: true });
const rows = db.prepare(`
    SELECT public_id AS id, username, discord_name AS discord, rp,
           dust_milli / 1000.0 AS gemdust,
           datetime(created_at / 1000, 'unixepoch') AS created,
           datetime(last_seen_at / 1000, 'unixepoch') AS last_seen
    FROM users WHERE deleted_at IS NULL ORDER BY created_at`).all();
console.table(rows);
console.log(`${rows.length} account(s)`);
