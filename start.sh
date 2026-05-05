#!/usr/bin/env sh
set -eu

cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "[X] Node.js not found."
  echo "Install Node.js 18+ and try again."
  exit 1
fi

echo "========================================"
echo "   MimirLink Launcher"
echo "========================================"
echo

echo "[OK] Node.js detected: $(node -v)"
echo

if [ ! -d node_modules ]; then
  echo "[!] Installing dependencies..."
  npm install
  echo
fi

if [ ! -f config.json ]; then
  if [ -f config.example.json ]; then
    echo "[!] Creating config.json from config.example.json ..."
    cp config.example.json config.json
    echo "[OK] config.json created."
    echo "Edit config.json and run again."
    exit 0
  fi
fi

mkdir -p data/characters data/chats logs

PORT="$(node -e "const fs=require('fs');try{const cfg=JSON.parse(fs.readFileSync('config.json','utf8'));process.stdout.write(String(cfg?.server?.port||18001));}catch{process.stdout.write('18001');}")"

echo "========================================"
echo "   Starting MimirLink"
echo "========================================"
echo
echo "[i] Web UI: http://127.0.0.1:${PORT}"
echo "[i] OneBot URL: check config.json"
echo "[i] Press Ctrl+C to stop."
echo

exec npm run start
