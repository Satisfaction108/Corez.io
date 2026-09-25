# Corez.io

Corez.io is a free, fast top-down battle royale you play right in your browser. Drive a tank through an underground world packed with rock, blast your way through it, and dig up copper, azurite, purple shards and rare emeralds. Bank your haul in a vault before someone takes it, because anyone carrying a full satchel is a target.

Every raid runs for two hours and you can jump in any time. A storm keeps closing in, so fights come to you whether you like it or not. Crack open loot chests, grab kit items from the shop pads, team up on giant bosses guarding the richest veins, and try to finish the raid at the top of the board.

Play at **https://digwars.hackclub.app** and come hang out on our **[Discord](https://discord.gg/qtwajWhaGc)**.

## What's in it

- **Battle royale raids:** 2-hour always-on raids with a shrinking storm, raid scoring and rewards for the top spots.
- **Mining:** living rock that slowly grows back, ore blooms, and vaults to bank your gems.
- **Shops, bosses and events:** in-raid shop pads, kit items like the Rock Barrage, raid bosses, loot chests and raid twists.
- **Accounts:** play as a guest, or log in with Discord or a username to save your progress.
- **Ranked:** climb from Bronze to Emerald, then fight for a numbered Legend spot. Your first 3 games are placement games.
- **Gemdust and the Item Shop:** earn gemdust by banking gems, getting knockouts and placing top 3, then spend it on name styles and tank skins in a daily rotating shop.
- **Friends:** add friends, see who's online, chat from the menu or mid-raid, and send gifts.
- **Daily quests and achievements** for extra gemdust.
- **Bots** that mine, bank, chat and fight, so a raid is never empty.
- **A hands-on tutorial** on its own server.

## Running it yourself

You need Node.js 22.13 or newer (the account system uses Node's built-in SQLite).

```
npm install
npm start
```

Then open http://localhost:3000. Server settings live in `server/config.js`, and secrets go in `server/.env`. See `server/.env.example` for every option, including Discord login and the Discord bot. Without a `.env` the game still runs; everyone just plays as a guest.

## Where things are

- `index.js` - the server entry point
- `server/server.js` - starts the web server and the game servers
- `server/game/index.js` - the main game loop and entity logic
- `server/game/gamemodes/scripts/dig_royale.js` - the battle royale raid rules
- `server/game/terrain/` - the rock grid, mining, vaults, shops, bosses, chests and events
- `server/accounts/` - accounts, ranked, gemdust, the Item Shop, friends, quests and the Discord bot
- `server/lib/definitions/` - tank, bullet, boss and prop definitions
- `shared/` - rules shared by the server and the browser (ranks and cosmetics)
- `public/index.html` - the homepage and game canvas
- `public/client/app.js` - the game renderer and HUD
- `public/client/account/` - the menu screens: login, shop, locker, friends, profile and leaderboard
- `public/client/terrainRenderer.js` - draws the rock
- `public/changelog.md` - the update notes shown in the game
- `scripts/test/` - tests (`node scripts/test/accounts.test.js` and friends)
- `credits.md` - who worked on what

## Credits

Built on top of the open-source arras.io project. See `credits.md` for everyone who helped, and `LICENSE` for the license.
