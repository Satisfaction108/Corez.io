#!/usr/bin/env bash
# one-shot provision for a fresh hackclub nest container (debian 13)
set -euo pipefail

APP_DIR="${1:-$HOME/digwars}"
BRANCH="dig-wars"
PORT="${PORT:-3000}"
PUBLIC_HOST="${PUBLIC_HOST:-corez.io}"
REPO="https://github.com/Satisfaction108/Arras2.git"

# root (like a fresh nest container) doesn't need sudo; regular users do.
if [ "$(id -u)" -eq 0 ]; then SUDO=""; else SUDO="sudo"; fi

echo "[1/6] system packages"
$SUDO apt-get update -y
$SUDO apt-get install -y git curl

echo "[2/6] node 20+ (apt first, nvm fallback)"
if ! command -v node >/dev/null 2>&1; then
  $SUDO apt-get install -y nodejs npm
fi
if [ "$(node -e 'console.log(process.version.slice(1).split(".")[0])' 2>/dev/null || echo 0)" -lt 20 ]; then
  echo "apt node is too old, installing node 22 via nvm..."
  export NVM_DIR="$HOME/.nvm"
  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
  . "$NVM_DIR/nvm.sh"
  nvm install 22
  nvm alias default 22
fi
node -v

echo "[3/6] pm2"
npm install -g pm2

echo "[4/6] clone + deps"
if [ ! -d "$APP_DIR/.git" ]; then
  git clone -b "$BRANCH" "$REPO" "$APP_DIR"
else
  git -C "$APP_DIR" fetch origin
  git -C "$APP_DIR" checkout "$BRANCH" || true
  git -C "$APP_DIR" pull --ff-only origin "$BRANCH"
fi
cd "$APP_DIR"
npm install

echo "[5/6] .env"
if [ ! -f server/.env ]; then
  cp server/.env.example server/.env
  echo "!! server/.env created from example - edit it and set real secrets before going live"
fi

echo "[6/6] pm2 + auto-start"
pm2 delete digwars 2>/dev/null || true
SINGLE_PROCESS=true PORT="$PORT" PUBLIC_HOST="$PUBLIC_HOST" pm2 start server/server.js --name digwars
pm2 save
pm2 startup || true

echo
echo "done. next steps:"
echo "  1. nano $APP_DIR/server/.env   <- set real secrets"
echo "  2. pm2 restart digwars"
echo "  3. curl http://localhost:$PORT/getServers.json   <- expect json"
echo "  4. in the nest dashboard, Domains tab: add $PUBLIC_HOST -> port $PORT"
echo "  5. play at https://$PUBLIC_HOST"

