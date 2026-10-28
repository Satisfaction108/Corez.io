# Corez.io

A 2D tank game where you mine for gems, bank them, and fight everyone else doing the same thing. You play it in your browser at **https://corez.io**.

The map is mostly rock. You shoot through it to dig out gems, and you carry them until you drop them off at a vault. If you die before you bank, whoever killed you gets a lot of what you were carrying. Points level up your tank, and the tank tree works like arras, so you pick a new class as you grow.

There's no lobby or match to wait for. The world is always running, and you just press Play and drop in.

Come say hi on the **[Discord](https://discord.gg/bx5FK3CMwp)**.

## How it plays

The game switches mode every day. One day it's FFA, the next day it's 2TDM, and it keeps going back and forth.

In **FFA** it's everyone for themselves. Mine, bank, and try to finish the day high on the leaderboard.

In **2TDM** you're on Blue or Red. Each team has a base, and stepping onto the enemy's tiles kills you instantly. Banking gems adds to your team's score. Banking and winning fights also fill a War Meter, which you can spend on things like supply crates or a Titan that walks over to the enemy base. If you reload the page you stay on the same team.

Some other things you'll run into:

- **Perks.** You get to pick a new perk every 5,000 points. They stack up to tier IV.
- **Dying.** You lose half your points but keep your perks, and you come back with part of your banked gems.
- **Abilities** like the Grapple Hook, Shockwave, Barricade and Launch Pad. You can buy them at shop pads or pick them up from chests.
- **Events** every few minutes: Core Siege, Gem Rush, King of the Vault, Boss Hunt, Meteor Shower and Storm Circle (FFA only).
- **Hunted.** Whoever is #1 on the leaderboard gets a bounty on their head.
- **Bots** that mine, bank and fight, so the world never feels empty.
- **The tank tree.** Press T in game to see where you are and everything you can still upgrade into.

## Accounts

You can play as a guest. If you make an account (with Discord or a username), your stuff gets saved: your level, rank, gemdust and skins. You earn gemdust by playing and spend it in the Item Shop, which changes every day. There are also friends, daily quests, achievements and a ranked ladder that goes from Bronze up to Legend.

## Running it yourself

You need Node.js 22.13 or newer. The account system uses Node's built-in SQLite, and older versions don't have it.

```bash
npm install
```

```bash
npm start
```

Then open http://localhost:3000.

Game settings are in `server/config.js`. Secrets go in `server/.env`, and `server/.env.example` lists every option, including Discord login. You don't need a `.env` to run it. Without one, everyone just plays as a guest.

When you run it locally, the browser loads the normal code from `public/client`. In production (`NODE_ENV=production`) it loads an obfuscated copy from `build/public` instead. `npm run build` makes that copy, and `scripts/deploy.sh` runs the build for you. If you want to try the obfuscated build locally, set `CLIENT_BUILD=obfuscated`. Only edit files in `public/client`. The `build/` folder gets regenerated and isn't committed.

A few environment variables you might want:

- `ROYALE_MODES` picks which modes rotate. The default is `2tdm,ffa`, and setting just one keeps the server on that mode.
- `ROYALE_MODE_MIN` sets how many minutes each mode lasts. The default is 1440, which is one day.
- `ROYALE_ARMS_RACE=1` turns on the Arms Race tank tree.

## Where things are

- `index.js` starts everything.
- `server/game/index.js` has the main game loop.
- `server/game/gamemodes/scripts/dig_royale.js` has most of the game rules: spawning, scoring and dying.
- `server/game/terrain/` has the rock, mining, vaults, shops, perks, abilities, events, teams and mode rotation.
- `server/accounts/` has accounts, ranked, gemdust, the Item Shop, friends, quests and the Discord bot.
- `server/lib/definitions/` has the tank, bullet and boss definitions.
- `shared/` has code that both the server and the browser use, like ranks and cosmetics.
- `public/index.html` is the home page and game canvas.
- `public/client/app.js` draws the game and the HUD.
- `public/client/account/` has the menu screens.
- `public/changelog.md` has the update notes players see in game.
- `scripts/test/` has the tests. You run each one on its own, for example `node scripts/test/accounts.test.js`.

## Credits

Corez is built on top of the open-source arras.io code. Everyone who helped is listed in `credits.md`.

## License

Corez.io is licensed under the **GNU Affero General Public License v3.0 or later** (see `LICENSE`). You can read the code, run it, change it and share it. If you host a modified version that other people play, you have to publish your full source under the same license.

The arras.io code it's built on keeps its original MIT License (`LICENSE-ARRAS`). The license doesn't cover the Corez.io name or logo, so if you run your own copy, please give it a different name and logo. `NOTICE` has the details.
