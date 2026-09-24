// Accounts configuration, parsed from process.env.
//
// load() runs once when this module is first required and again from
// initMain(), because server.js reads server/.env into process.env after
// some modules are already loaded. Everything else reads config.<field> at
// call time, never at require time, so a reload is always picked up.
'use strict';

const path = require('path');
const nodeCrypto = require('crypto');

const REPO_ROOT = path.join(__dirname, '..', '..');
const LOCAL_HOST_RE = /^(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/i;
const DEV_ORIGIN_RE = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/;

// Kept across reloads: regenerating it would invalidate every signed cookie
// (Discord state, pending signup) issued earlier in this boot.
let devSecret = null;

const config = {
    load,
    isAllowedOrigin,
    // Filled by load():
    isProd: false,
    publicOrigin: 'http://localhost:3000',
    secure: false,
    allowedOrigins: new Set(),
    trustedProxies: [],
    sessionSecret: '',
    secretOk: false,
    accountsFlag: true,
    dataDir: path.join(REPO_ROOT, 'data'),
    dbPath: path.join(REPO_ROOT, 'data', 'digwars.db'),
    discord: { clientId: '', clientSecret: '', redirectUri: '' },
    discordLogin: false,
    cookies: { session: 'dw_sid', oauth: 'dw_oauth', pending: 'dw_pending', dev: 'dw_dev' },
};

function normalizeOrigin(origin) {
    return String(origin || '').trim().toLowerCase().replace(/\/+$/, '');
}

function load(env = process.env) {
    const port = parseInt(env.PORT) || 3000;
    const publicHost = String(env.PUBLIC_HOST || '').trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');

    config.publicOrigin = normalizeOrigin(
        env.PUBLIC_ORIGIN || (publicHost ? `https://${publicHost}` : `http://localhost:${port}`)
    );
    // Production (strict) = NODE_ENV=production or a real PUBLIC_HOST, and
    // also a real PUBLIC_ORIGIN, so a deploy that only sets that is not
    // left accepting localhost origins and a throwaway secret.
    const originHost = config.publicOrigin.replace(/^https?:\/\//, '');
    config.isProd = env.NODE_ENV === 'production'
        || (!!publicHost && !LOCAL_HOST_RE.test(publicHost))
        || !LOCAL_HOST_RE.test(originHost);
    config.secure = config.publicOrigin.startsWith('https://');

    config.allowedOrigins = new Set([config.publicOrigin]);
    for (const o of String(env.ALLOWED_ORIGINS || '').split(',')) {
        const n = normalizeOrigin(o);
        if (n) config.allowedOrigins.add(n);
    }
    config.trustedProxies = String(env.TRUSTED_PROXIES || '127.0.0.1,::1').split(',').map(s => s.trim()).filter(Boolean);

    // SESSION_SECRET signs the short-lived cookies (Discord state, pending
    // signup). Session tokens themselves are random and stored hashed.
    const secret = String(env.SESSION_SECRET || '');
    if (secret.length >= 32) {
        config.sessionSecret = secret;
        config.secretOk = true;
    } else if (config.isProd) {
        config.sessionSecret = '';
        config.secretOk = false;
    } else {
        if (secret) {
            config.sessionSecret = secret;
        } else {
            if (!devSecret) devSecret = nodeCrypto.randomBytes(32).toString('base64url');
            config.sessionSecret = devSecret;
        }
        config.secretOk = true;
    }
    config.secretWarning = secret.length >= 32 ? '' : config.isProd
        ? 'SESSION_SECRET is missing or shorter than 32 characters; accounts are disabled in production'
        : secret
            ? 'SESSION_SECRET is shorter than 32 characters (allowed outside production only)'
            : 'SESSION_SECRET is not set; using a random per-boot secret (dev only)';

    config.accountsFlag = !/^(0|false|no|off)$/i.test(String(env.ACCOUNTS_ENABLED || 'true').trim());
    config.dataDir = path.resolve(env.DATA_DIR || path.join(REPO_ROOT, 'data'));
    config.dbPath = path.resolve(env.DB_PATH || path.join(config.dataDir, 'digwars.db'));
    config.backupDir = path.join(config.dataDir, 'backups');

    config.discord = {
        clientId: String(env.DISCORD_CLIENT_ID || '').trim(),
        clientSecret: String(env.DISCORD_CLIENT_SECRET || '').trim(),
        redirectUri: String(env.DISCORD_REDIRECT_URI || '').trim() || `${config.publicOrigin}/auth/discord/callback`,
    };
    config.discordLogin = !!(config.discord.clientId && config.discord.clientSecret);

    // __Host- cookies must be Secure, Path=/ and host-only, so the prefix is
    // only used over https. The others are path-scoped and cannot use it.
    config.cookies = {
        session: config.secure ? '__Host-dw_sid' : 'dw_sid',
        oauth: 'dw_oauth',
        pending: 'dw_pending',
        dev: 'dw_dev',
    };
    return config;
}

// Exact match against PUBLIC_ORIGIN + ALLOWED_ORIGINS; outside production any
// http://localhost:* / http://127.0.0.1:* page is also allowed.
function isAllowedOrigin(origin) {
    if (!origin || typeof origin !== 'string') return false;
    const n = normalizeOrigin(origin);
    if (config.allowedOrigins.has(n)) return true;
    return !config.isProd && DEV_ORIGIN_RE.test(n);
}

load();

module.exports = config;
