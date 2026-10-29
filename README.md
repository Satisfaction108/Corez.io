# Corez.io

An online 2D tank game where you mine, and bank gems and battle others doing the same. Play it at **https://corez.io**.

The map is made up of rock. You can shoot through this and mine gems. Once gathered you can carry them to the vault to bank them. If you are killed you will give most of your carried gems to the player who killed you. As you gain points you will level up your tank. The tank tree works similar to arras, giving you a new class.

No lobbies or matches, play now.

**[Come chat on Discord](https://discord.gg/bx5FK3CMwp)**

## Gameplay

Every day we cycle between **FFA** and **2TDM**.

During **FFA** it is free for all. Try and mine, bank and end the day high on the leaderboards.

During **2TDM** you will be either on Blue or Red. Each team will have a base. Stepping onto the enemy team's tiles will kill you instantly. Mining gems will increase your team's score. Mining and winning battles will increase your War Meter. This can be used to buy different items like supply crates and a Titan which walks to the enemy base. If you refresh the page you will stay on the same team.

Other features:

- **Perks** - Every 5000 points you can choose a new perk. Up to tier IV.
- **Death** - You will lose half your points but retain your perks. You will spawn with some of your banked gems.
- **Abilities** - Grapple Hook, Shockwave, Barricade and Launch Pad can be purchased from shop pads, or found in chests.
- **Events** - Every few minutes there will be events. Core Siege, Gem Rush, King of the Vault, Boss Hunt, Meteor Shower and Storm Circle (FFA only).
- **Hunted** - The player who is #1 on the leaderboard will become hunted.
- **Bots** - There are bots in the game that will mine, bank and battle. Ensuring the world never feels empty.
- **Tank Tree** - Press T during the game to view what tanks you are and can upgrade to.

## Accounts

You can play as a guest. If you make an account using Discord or username you will save your progress. This includes your level, rank, gemdust and skins. Gemdust can be earned by playing and used in the Item Shop. This changes every day. Friends, daily quests, achievements and a ranked leaderboard (Bronze - Legend) are all available.

## Hosting

To run you will need Node.js 22.13 or above. The account system uses Node's built in SQLite so older versions won't work.

Install dependencies:

```bash
npm install
```

Run:

```bash
npm start
```

Go to http://localhost:3000.

Config for the game can be found in `server/config.js`. Secrets can be stored in `server/.env`. All options are listed in `server/.env.example`. You do not need to have a `.env` file. If you don't then everyone will play as a guest.

When running locally you will load the un-obfuscated code from `public/client`. When running in production (`NODE_ENV=production`) you will load the obfuscated code from `build/public`. This can be built using `npm run build`. This can also be done using `scripts/deploy.sh`. If you want to test the obfuscated code locally then set `CLIENT_BUILD=obfuscated`. Only edit files inside `public/client`. The contents of `build/` will be rebuilt and not committed.

Some useful environment variables:

- `ROYALE_MODES` - This will determine the modes to cycle through. Default is `2tdm,ffa`. If you only set 1 mode then it will always run on that mode.
- `ROYALE_MODE_MIN` - Sets how long each mode should run for. Default is 1440 (1 day).
- `ROYALE_ARMS_RACE=1` - Enables the Arms Race tank tree.

## Files

- Main entry point: `index.js`.
- Main game loop: `server/game/index.js`.
- Most of the gameplay logic can be found in `server/game/gamemodes/scripts/dig_royale.js`. This includes spawning, scoring and death.
- Terrain, rock, mining, vaults, shops, perks, abilities, events, teams and mode cycling can be found in `server/game/terrain/`.
- Accounts, ranked, gemdust, item shop, friends, quests and discord bot can be found in `server/accounts/`.
- Tank, bullet and boss definitions can be found in `server/lib/definitions/`.
- Shared files for the server and client. Ranks and cosmetcs are in `shared/`.
- Home page and game canvas: `public/index.html`.
- Game rendering and HUD: `public/client/app.js`.
- Menu screens: `public/client/account/`.
- Update notes: `public/changelog.md`.
- Testing scripts: `scripts/test/`. Run each script individually. For example `node scripts/test/accounts.test.js`.

## Credits

Corez is based on the open source arras.io code. Everyone who has helped can be found in `credits.md`.

## Licence

Corez.io is released under the **GNU Affero General Public License v3.0+**. (See `LICENSE`). This means you can view, run, modify and share the code. However if you host a modified version of the game that others play you must release your full source under the same licence.

The arras.io code remains MIT Licensed (`LICENSE-ARRAS`). This does not apply to the name or logo. If you are hosting your own copy please rename it and give it a new logo. See `NOTICE` for details.
