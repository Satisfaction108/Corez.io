// Discord REST through fetch (no discord.js). One request at a time, in
// order: a 429 waits retry_after and tries again (up to 5 times), and an
// exhausted bucket (X-RateLimit-Remaining: 0) waits Reset-After before the
// next request. Every message goes out with allowed_mentions: none, so no
// text we post (usernames included) can ping anyone.
'use strict';

const config = require('../config');

const API = 'https://discord.com/api/v10';
const MAX_TRIES = 5;
const NO_MENTIONS = Object.freeze({ parse: [] });

let fetchImpl = (...args) => globalThis.fetch(...args);
function setFetchForTests(fn) { fetchImpl = fn || ((...args) => globalThis.fetch(...args)); }

const sleep = ms => new Promise(r => { const t = setTimeout(r, ms); if (t.unref) t.unref(); });

let chain = Promise.resolve();
let pauseUntil = 0;

function headers(extra) {
    return {
        Authorization: 'Bot ' + config.discordBot.botToken,
        'User-Agent': `DiscordBot (${config.publicOrigin}, 1.0)`,
        ...(extra || {}),
    };
}

// makeBody() is called per attempt (a FormData body cannot be re-sent).
async function attempt(method, route, makeBody, timeoutMs) {
    for (let tries = 1; ; tries++) {
        const wait = pauseUntil - Date.now();
        if (wait > 0) await sleep(wait);
        const b = makeBody ? makeBody() : null;
        const res = await fetchImpl(API + route, {
            method,
            headers: headers(b && b.headers),
            body: b ? b.body : undefined,
            signal: AbortSignal.timeout(timeoutMs),
        });
        const text = await res.text();
        let body = null;
        try { body = text ? JSON.parse(text) : null; } catch (e) { body = text; }
        const remaining = res.headers.get('x-ratelimit-remaining');
        const resetAfter = parseFloat(res.headers.get('x-ratelimit-reset-after'));
        if (remaining === '0' && resetAfter > 0) pauseUntil = Math.max(pauseUntil, Date.now() + resetAfter * 1000);
        if (res.status === 429 && tries < MAX_TRIES) {
            const ra = (body && typeof body === 'object' && +body.retry_after) || parseFloat(res.headers.get('retry-after')) || 1;
            const ms = Math.min(60000, Math.ceil(ra * 1000) + 100);
            if (body && body.global) pauseUntil = Math.max(pauseUntil, Date.now() + ms);
            await sleep(ms);
            continue;
        }
        if (!res.ok) {
            const e = new Error(`Discord ${method} ${route.replace(/\/webhooks\/\d+\/[^/]+/, '/webhooks/…')} -> ${res.status}: ${typeof body === 'string' ? body.slice(0, 200) : JSON.stringify(body).slice(0, 200)}`);
            e.status = res.status;
            throw e;
        }
        return body;
    }
}

// Queued. -> parsed JSON body; throws on a final error.
function request(method, route, makeBody, timeoutMs = 30000) {
    if (!config.discordBot.botToken) return Promise.reject(new Error('DISCORD_BOT_TOKEN is not set'));
    const p = chain.then(() => attempt(method, route, makeBody, timeoutMs));
    chain = p.catch(() => {});
    return p;
}

function jsonBody(obj) {
    return () => ({ headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });
}

// message: {content?, embeds?}
function sendMessage(channelId, message) {
    return request('POST', `/channels/${channelId}/messages`, jsonBody({ ...message, allowed_mentions: NO_MENTIONS }));
}

// One file attachment (Buffer) with an optional message.
function sendFile(channelId, content, filename, buffer, timeoutMs = 120000) {
    return request('POST', `/channels/${channelId}/messages`, () => {
        const form = new FormData();
        form.append('payload_json', JSON.stringify({
            content: content || '', allowed_mentions: NO_MENTIONS,
            attachments: [{ id: 0, filename }],
        }));
        form.append('files[0]', new Blob([buffer], { type: 'application/octet-stream' }), filename);
        return { body: form };
    }, timeoutMs);
}

// Command registration (scripts/discord-register.js): bulk overwrite.
function putCommands(appId, guildId, commands) {
    const route = guildId ? `/applications/${appId}/guilds/${guildId}/commands` : `/applications/${appId}/commands`;
    return request('PUT', route, jsonBody(commands));
}

// Markdown-safe text: usernames are [A-Za-z0-9_], but anything we echo is
// escaped all the same (and mentions are off anyway).
function escapeMd(text) {
    return String(text == null ? '' : text).replace(/([\\`*_~|>#\[\]()<:@-])/g, '\\$1').replace(/\n/g, ' ');
}

module.exports = { API, NO_MENTIONS, request, sendMessage, sendFile, putCommands, escapeMd, setFetchForTests };
