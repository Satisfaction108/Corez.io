# Corez.io

Corez.io is an online 2D tank game where you mine rocks, collect gems, and bank them while battling others doing the same! Play now at: **https://corez.io** :D

The map is made up of many variants of rocks including sandstone and granite. You can shoot through these rocks, and some rocks have gems that you can collect and bank to increase your points and buy shop items! If you are killed, you will give most of your carried gems to the player who killed you, and a linear curve function also calculates how much score you get based on the score of the person you killed... and you also can respawn with 1/4th of your score!!

You can instantaneously upgrade your tank on spawn offering well more than 1000 tanks to choose from while being balanced and having no unfair advantages. 

**[Come say hi on our discord! :D](https://discord.gg/bx5FK3CMwp)**

## Gameplay

Every day we cycle between **FFA** and **2TDM** (2TDM is just 2 Team Death Match - or just a 2 team gamemode lol)

During **FFA** it is free for all and you try to mine, bank, and end the day with a high score on the leaderboards.

During **2TDM** you will be either on Blue or Red. Each team will have a base and stepping onto the enemy team's tiles will kill you instantly. Mining gems will increase your team's score and a "war effort" meter. Mining and winning battles will also increase your War Meter. This can be used to buy different items like supply crates and a Titan which walks to the enemy base and helps you push the opponent (thought it has a 90 sec cooldown).

Other features:
0
- **Perks** - Every 5000 points you can choose a new perk which can give you stuff like ore magnet or an ability to mine rocks faster
- **Death** - You will lose 3/4th of your points and half of your perks, but you can respawn right away and start grinding again
- **Abilities** - Grapple Hook, Shockwave, Barricade and Launch Pad, Burrow Drill, etc. can either be unlocked from a supply crate, chest, or by buying it at the shop. Once you equip an ability you can use it (ex. Grapple Hook hooks onto the rock or enemy you aim it at).
- **Events** - Every few minutes there will be an event. Core Siege, Gem Rush, King of the Vault, Boss Hunt, Meteor Shower and Storm Circle are there in FFA while there are no events except occasional boss spawns in 2TDM.
- **Hunted** - The player who is #1 on the leaderboard will become hunted (dont worry you wont be killed... if ur good :p)
- **Bots** - There are bots in the game that will mine, bank and fight, though they decrease when more people join... so you arent in a bot filled lobby. 
- **Tank Tree** - Press T during the game to view what tanks you are and can upgrade to! Since the tank tree is too big it will only show the basic tanks and then clicking on one will open the tree to the others.

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

- Entry point/File to fetch to run the server: `index.js`.
- Main game loop: `server/game/index.js`.
- Most of the gameplay logic can be found in `server/game/gamemodes/scripts/dig_royale.js`. This includes spawning, scoring and death, and basically the entire "battle royale" logic.
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
