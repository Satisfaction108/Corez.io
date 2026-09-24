// POST /discord/interactions: the Discord bot's HTTP interactions endpoint.
//
// Off (404) unless DISCORD_APP_ID and DISCORD_PUBLIC_KEY are set. Every
// request must carry a valid Ed25519 signature (X-Signature-Ed25519 over
// X-Signature-Timestamp + raw body) with a timestamp within 5 minutes;
// anything else is 401, which is what Discord probes for when the endpoint
// URL is saved. PING -> PONG (type 1); slash commands -> discord/commands.js.
// Served while accounts are off too (alwaysOn), so the endpoint stays
// verified; commands then answer that accounts are offline.
'use strict';

const config = require('../config');
const { HttpError } = require('../http');
const verify = require('../discord/verify');
const commands = require('../discord/commands');

const BODY_LIMIT = 64 * 1024;

function readRaw(req, limit = BODY_LIMIT) {
    return new Promise((resolve, reject) => {
        if (Number(req.headers['content-length']) > limit) return reject(new HttpError(413, 'payload_too_large', 'Request body too large.', null, { Connection: 'close' }));
        const chunks = [];
        let size = 0, done = false;
        req.on('data', c => {
            if (done) return;
            size += c.length;
            if (size > limit) { done = true; reject(new HttpError(413, 'payload_too_large', 'Request body too large.', null, { Connection: 'close' })); return; }
            chunks.push(c);
        });
        req.on('end', () => { if (!done) { done = true; resolve(Buffer.concat(chunks)); } });
        req.on('error', () => { if (!done) { done = true; reject(new HttpError(400, 'bad_request', 'Request body could not be read.')); } });
    });
}

async function interactions(ctx) {
    const bot = config.discordBot;
    if (!bot.interactions) throw new HttpError(404, 'not_found', 'No such endpoint.');
    const raw = await readRaw(ctx.req);
    const ok = verify.verify(bot.publicKey, ctx.header('x-signature-ed25519'), ctx.header('x-signature-timestamp'), raw);
    if (!ok) throw new HttpError(401, 'invalid_signature', 'invalid request signature');
    let i;
    try { i = JSON.parse(raw.toString('utf8')); } catch (e) { throw new HttpError(400, 'bad_json', 'Request body is not valid JSON.'); }
    if (!i || typeof i !== 'object') throw new HttpError(400, 'bad_json', 'Request body must be a JSON object.');
    if (bot.appId && i.application_id && String(i.application_id) !== bot.appId) throw new HttpError(401, 'invalid_signature', 'wrong application');
    if (i.type === 1) return ctx.json(200, { type: 1 });
    if (i.type === 2) {
        let res;
        try { res = commands.handle(i); } catch (e) {
            console.error('[discord] command /' + ((i.data && i.data.name) || '?') + ' failed: ' + ((e && e.stack) || e));
            res = commands.reply('Something went wrong running that command.', { ephemeral: true });
        }
        return ctx.json(200, res);
    }
    // components / autocomplete / modals: none registered
    return ctx.json(200, commands.reply('Nothing to do here.', { ephemeral: true }));
}

function register(router) {
    router.add('POST', '/discord/interactions', interactions, { alwaysOn: true });
}

module.exports = { register };
