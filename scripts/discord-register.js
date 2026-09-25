#!/usr/bin/env node
// Registers the Corez.io slash commands with Discord (bulk overwrite, so a
// command removed from the list disappears too):
//   global           /profile /rank /leaderboard       (can take up to an hour to show)
//   admin guild      /lookup /resetpassword /relink /grantdust /ban /unban
//                    (default_member_permissions "0": hidden from non-admins)
//
//   node scripts/discord-register.js            register both
//   node scripts/discord-register.js --dry-run  print the JSON, send nothing
//
// Reads DISCORD_APP_ID, DISCORD_BOT_TOKEN and DISCORD_ADMIN_GUILD_ID from the
// environment, falling back to server/.env. Run it once after deploying, and
// again whenever the command list changes.
'use strict';

const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
try {
    const env = require(path.join(REPO, 'server/lib/dotenv.js'))(fs.readFileSync(path.join(REPO, 'server/.env'), 'utf8'));
    for (const k in env) if (process.env[k] === undefined) process.env[k] = env[k];
} catch (e) { if (e.code !== 'ENOENT') throw e; }

const config = require(path.join(REPO, 'server/accounts/config.js'));
config.load();
const rest = require(path.join(REPO, 'server/accounts/discord/rest.js'));
const { ADMIN_COMMANDS, PLAYER_COMMANDS } = require(path.join(REPO, 'server/accounts/discord/commands.js'));

async function main() {
    const bot = config.discordBot;
    if (process.argv.includes('--dry-run')) {
        console.log(JSON.stringify({ global: PLAYER_COMMANDS, guild: ADMIN_COMMANDS }, null, 2));
        return;
    }
    const missing = [];
    if (!bot.appId) missing.push('DISCORD_APP_ID');
    if (!bot.botToken) missing.push('DISCORD_BOT_TOKEN');
    if (missing.length) {
        console.error('Missing ' + missing.join(', ') + ' (environment or server/.env).');
        process.exit(1);
    }
    // Direct PUTs, not the shared rate-limit queue: a one-off script has no
    // other traffic, and the queue could leave it waiting forever.
    const put = async (guildId, commands) => {
        const route = guildId ? `/applications/${bot.appId}/guilds/${guildId}/commands` : `/applications/${bot.appId}/commands`;
        const r = await fetch(rest.API + route, {
            method: 'PUT', signal: AbortSignal.timeout(20000),
            headers: { Authorization: 'Bot ' + bot.botToken, 'Content-Type': 'application/json' },
            body: JSON.stringify(commands),
        });
        const j = await r.json().catch(() => null);
        if (!r.ok) throw new Error(`Discord PUT ${route} -> ${r.status}: ${JSON.stringify(j)}`);
        return j;
    };
    const g = await put(null, PLAYER_COMMANDS);
    console.log(`global: ${g.map(c => '/' + c.name).join(' ')}`);
    if (bot.adminGuildId) {
        const a = await put(bot.adminGuildId, ADMIN_COMMANDS);
        console.log(`guild ${bot.adminGuildId}: ${a.map(c => '/' + c.name).join(' ')}`);
    } else {
        console.warn('DISCORD_ADMIN_GUILD_ID is not set: admin commands were not registered.');
    }
    if (!bot.adminIds.size) console.warn('ADMIN_DISCORD_IDS is empty: nobody can run the admin commands.');
    if (!bot.publicKey) console.warn('DISCORD_PUBLIC_KEY is not set (or not 64 hex chars): the server will not answer interactions.');
    console.log(`Now set the Interactions Endpoint URL to ${config.publicOrigin}/discord/interactions in the developer portal (the server must be running).`);
}

main().catch(e => { console.error((e && e.message) || e); process.exit(1); });
