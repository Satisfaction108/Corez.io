#!/usr/bin/env bash
# Pull the latest dig-wars branch and restart the game under pm2.
# Oracle (live): ~/corez, pm2 app "corez". Old Nest box: ~/digwars, app "digwars".
set -euo pipefail

if [ -n "${1:-}" ]; then APP_DIR="$1"
elif [ -d "$HOME/corez" ]; then APP_DIR="$HOME/corez"
else APP_DIR="$HOME/digwars"; fi
APP_NAME="${PM2_APP:-$(basename "$APP_DIR")}"

cd "$APP_DIR"
GENERATED=(public/tanks/tanks.json public/tanks/atlas-s.webp public/tanks/atlas-l.webp scripts/tanks/atlas.map.json public/client/account/preview-mockups.json)
git checkout -- "${GENERATED[@]}"
git pull --ff-only origin dig-wars
# --include=dev: the client build needs javascript-obfuscator even when the
# shell has NODE_ENV=production. A failed build stops the script here and
# leaves the previous build in place.
npm install --no-audit --no-fund --include=dev
npm run build
pm2 restart "$APP_NAME" --update-env
pm2 save
