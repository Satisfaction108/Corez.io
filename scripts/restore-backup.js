#!/usr/bin/env node
// Restores a Dig Wars backup made by server/accounts/backup.js:
// decrypt (AES-256-GCM, "DWB1" format) -> gunzip -> PRAGMA integrity_check.
//
//   node scripts/restore-backup.js <backup.dwb> [out.db] [--force]
//   node scripts/restore-backup.js <name.dwb.part1of3> [out.db]      (finds the other parts)
//   node scripts/restore-backup.js <part1> <part2> <part3> --out out.db
//
// The key comes from BACKUP_ENCRYPTION_KEY (environment, then server/.env).
// The output defaults to the backup's name with .db and is never
// overwritten without --force. To put it live: stop the server (pm2 stop),
// move the old digwars.db, digwars.db-wal and digwars.db-shm aside, copy the
// restored file to DB_PATH (chmod 600), and start the server again.
'use strict';

const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
try {
    const env = require(path.join(REPO, 'server/lib/dotenv.js'))(fs.readFileSync(path.join(REPO, 'server/.env'), 'utf8'));
    for (const k in env) if (process.env[k] === undefined) process.env[k] = env[k];
} catch (e) { if (e.code !== 'ENOENT') throw e; }

const config = require(path.join(REPO, 'server/accounts/config.js'));
const backup = require(path.join(REPO, 'server/accounts/backup.js'));

function usage(msg) {
    if (msg) console.error(msg);
    console.error('usage: node scripts/restore-backup.js <backup.dwb | part1 [part2 ...]> [out.db] [--out out.db] [--force]');
    process.exit(1);
}

// name.dwb.part2of3 -> every part of that set, in order
function partsOf(file) {
    const m = /^(.*)\.part(\d+)of(\d+)$/.exec(file);
    if (!m) return [file];
    const n = +m[3];
    const list = [];
    for (let k = 1; k <= n; k++) {
        const p = `${m[1]}.part${k}of${n}`;
        if (!fs.existsSync(p)) usage('missing part ' + p);
        list.push(p);
    }
    return list;
}

async function main() {
    const args = process.argv.slice(2);
    const force = args.includes('--force');
    let out = null;
    const files = [];
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '--force') continue;
        if (a === '--out') { out = args[++i]; continue; }
        if (/\.db$/i.test(a) && files.length) { out = a; continue; }
        files.push(a);
    }
    if (!files.length) usage();
    const key = config.parseBackupKey(process.env.BACKUP_ENCRYPTION_KEY);
    if (!key) usage('BACKUP_ENCRYPTION_KEY is missing or not a 32-byte key (base64 or hex).');
    const inputs = files.length === 1 ? partsOf(files[0]) : files;
    for (const f of inputs) if (!fs.existsSync(f)) usage('no such file: ' + f);
    const data = Buffer.concat(inputs.map(f => fs.readFileSync(f)));
    if (!out) out = inputs[0].replace(/(\.part\d+of\d+)?$/, '').replace(/\.dwb$/i, '') + '.db';
    if (fs.existsSync(out) && !force) usage(out + ' exists; pass --force to overwrite it.');

    const plain = await backup.unpack(data, key);
    const tmp = out + '.restoring';
    fs.writeFileSync(tmp, plain, { mode: 0o600 });
    const check = backup.integrityCheck(tmp);
    if (check !== 'ok') {
        fs.unlinkSync(tmp);
        console.error('integrity_check FAILED: ' + check);
        process.exit(2);
    }
    fs.renameSync(tmp, out);
    console.log(`restored ${inputs.length > 1 ? inputs.length + ' parts' : path.basename(inputs[0])} -> ${out} (${(plain.length / 1048576).toFixed(2)} MB, integrity ok)`);
}

main().catch(e => { console.error((e && e.message) || e); process.exit(1); });
