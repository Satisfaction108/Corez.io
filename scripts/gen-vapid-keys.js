// Makes a fresh VAPID key pair for web push and writes it into an env file.
//
//   node scripts/gen-vapid-keys.js                      writes server/.env
//   node scripts/gen-vapid-keys.js --env /path/.env     another file
//   node scripts/gen-vapid-keys.js --subject mailto:you@example.com
//   node scripts/gen-vapid-keys.js --force              replace a pair already there
//
// Adds WEB_PUSH_PUBLIC_KEY, WEB_PUSH_PRIVATE_KEY and (if given or missing)
// WEB_PUSH_SUBJECT to the file, creating it with mode 0600 if needed. The
// private key is never printed; only the public one is, so you can check
// which pair a server runs with (GET /api/daily answers it as push.key).
//
// Do this ONCE per site. Every browser that subscribes is tied to the public
// key: a new pair means old subscriptions stop working (they get dropped as
// the push services refuse them) and players have to opt in again. So without
// --force an existing pair is left alone.
'use strict';

const fs = require('fs');
const path = require('path');
const webpush = require('../server/accounts/webpush');

function arg(name) {
    const i = process.argv.indexOf(name);
    return i >= 0 ? process.argv[i + 1] : null;
}
const file = path.resolve(arg('--env') || path.join(__dirname, '..', 'server', '.env'));
const subject = arg('--subject');
const force = process.argv.includes('--force');

if (subject && !/^(mailto:\S+@\S+|https:\/\/\S+)$/i.test(subject)) {
    console.error('--subject must be mailto:someone@example.com or an https:// URL');
    process.exit(1);
}

let text = '';
try { text = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
const has = (k) => new RegExp('^\\s*' + k + '\\s*=\\s*\\S', 'm').test(text);
if (has('WEB_PUSH_PRIVATE_KEY') && !force) {
    console.log(file + ' already has a WEB_PUSH key pair; left it alone (use --force to replace it, which breaks every existing subscription).');
    process.exit(0);
}

const k = webpush.generateKeys();
const set = (key, value) => {
    const re = new RegExp('^\\s*' + key + '\\s*=.*$', 'm');
    const line = key + '=' + value;
    text = re.test(text) ? text.replace(re, line) : text.replace(/\n*$/, text ? '\n' : '') + line + '\n';
};
if (!/web push/i.test(text)) text = text.replace(/\n*$/, text ? '\n\n' : '') + '# Web push (scripts/gen-vapid-keys.js). Keep this pair forever.\n';
set('WEB_PUSH_PUBLIC_KEY', k.publicKey);
set('WEB_PUSH_PRIVATE_KEY', k.privateKey);
if (subject) set('WEB_PUSH_SUBJECT', subject);
else if (!has('WEB_PUSH_SUBJECT')) set('WEB_PUSH_SUBJECT', 'mailto:admin@corez.io');

fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, text, { mode: 0o600 });
try { fs.chmodSync(file, 0o600); } catch (e) { /* best effort */ }
console.log('Wrote a new VAPID pair to ' + file);
console.log('Public key: ' + k.publicKey);
console.log('Restart the server (pm2 restart <app> --update-env) to pick it up.');
