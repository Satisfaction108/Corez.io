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
    parseBackupKey,
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
    shopSeedSalt: 'dw-shop-v1',
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

    config.shopSeedSalt = String(env.SHOP_SEED_SALT || '').trim() || 'dw-shop-v1';

    // Discord bot (HTTP interactions + REST). Each part switches on by itself:
    // the interactions endpoint needs APP_ID + PUBLIC_KEY, messages need the
    // bot token and a channel, admin commands need the guild and admin ids.
    const snow = v => { const s = String(v || '').trim(); return /^\d{5,25}$/.test(s) ? s : ''; };
    const bot = {
        appId: snow(env.DISCORD_APP_ID),
        publicKey: String(env.DISCORD_PUBLIC_KEY || '').trim().toLowerCase(),
        botToken: String(env.DISCORD_BOT_TOKEN || '').trim(),
        adminGuildId: snow(env.DISCORD_ADMIN_GUILD_ID),
        adminIds: new Set(String(env.ADMIN_DISCORD_IDS || '').split(',').map(snow).filter(Boolean)),
        announceChannelId: snow(env.DISCORD_ANNOUNCE_CHANNEL_ID),
        backupChannelId: snow(env.DISCORD_BACKUP_CHANNEL_ID),
    };
    if (!/^[0-9a-f]{64}$/.test(bot.publicKey)) bot.publicKey = '';
    bot.interactions = !!(bot.appId && bot.publicKey);
    bot.rest = !!bot.botToken;
    config.discordBot = bot;

    // Nightly encrypted backups: BACKUP_ENCRYPTION_KEY is 32 bytes, base64 or
    // hex (openssl rand -base64 32). Unset or malformed = backups off.
    config.backupKey = parseBackupKey(env.BACKUP_ENCRYPTION_KEY);
    config.backupKeyError = String(env.BACKUP_ENCRYPTION_KEY || '').trim() && !config.backupKey
        ? 'BACKUP_ENCRYPTION_KEY must decode to exactly 32 bytes (openssl rand -base64 32); backups are off' : '';
    const hour = parseInt(env.BACKUP_HOUR_UTC, 10);
    config.backupHourUtc = Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : 3;

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

// -> 32-byte Buffer | null. Base64 (or base64url) first, then 64 hex chars.
function parseBackupKey(value) {
    const s = String(value || '').trim();
    if (!s) return null;
    if (/^[0-9a-fA-F]{64}$/.test(s)) return Buffer.from(s, 'hex');
    if (/^[A-Za-z0-9+/_-]{43}=?$/.test(s)) {
        const b = Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
        if (b.length === 32) return b;
    }
    return null;
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
