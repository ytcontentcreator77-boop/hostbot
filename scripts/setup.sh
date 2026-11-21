#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

command -v node >/dev/null || { echo "Node.js 24+ is required."; exit 1; }
command -v curl >/dev/null || { echo "curl is required."; exit 1; }
command -v openssl >/dev/null || { echo "openssl is required."; exit 1; }

echo "HostPilot first-time deployment"
echo "This configures Cloudflare D1, Worker secrets, deployment and Telegram webhook."
echo

npm install

read -r -p "Public HTTPS Mini App URL (e.g. https://hostpilot.example.com): " APP_URL
APP_URL="${APP_URL%/}"
case "$APP_URL" in https://*) ;; *) echo "APP_URL must begin with https://"; exit 1;; esac

read -r -p "Owner Telegram numeric ID: " OWNER_IDS
case "$OWNER_IDS" in ''|*[!0-9,]*) echo "Enter one or more numeric Telegram IDs separated by commas."; exit 1;; esac

if [ -z "${BOT_TOKEN:-}" ]; then
  read -r -s -p "Telegram bot token from @BotFather (hidden): " BOT_TOKEN
  echo
fi
[ -n "$BOT_TOKEN" ] || { echo "BOT_TOKEN is required."; exit 1; }

echo "Checking Telegram bot token..."
BOT_INFO="$(curl -fsS "https://api.telegram.org/bot${BOT_TOKEN}/getMe")"
printf '%s' "$BOT_INFO" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);if(!j.ok)process.exit(1);console.log("Connected bot: @"+j.result.username)})' || { echo "Telegram rejected this token."; exit 1; }

if grep -q 'REPLACE_WITH_D1_DATABASE_ID' wrangler.jsonc; then
  echo "Creating Cloudflare D1 database..."
  D1_OUTPUT="$(npx wrangler d1 create hostpilot)"
  printf '%s\n' "$D1_OUTPUT"
  D1_ID="$(printf '%s\n' "$D1_OUTPUT" | sed -nE 's/.*database_id[[:space:]]*=[[:space:]]*"([^"]+)".*/\1/p' | head -n 1)"
  if [ -z "$D1_ID" ]; then
    read -r -p "Paste the database_id printed above: " D1_ID
  fi
  [ -n "$D1_ID" ] || { echo "A D1 database ID is required."; exit 1; }
  D1_ID="$D1_ID" node --input-type=module <<'NODE'
import fs from "node:fs";
const path="wrangler.jsonc";
const id=process.env.D1_ID;
const config=fs.readFileSync(path,"utf8").replace("REPLACE_WITH_D1_DATABASE_ID",id);
fs.writeFileSync(path,config);
NODE
fi

APP_URL="$APP_URL" OWNER_IDS="$OWNER_IDS" node --input-type=module <<'NODE'
import fs from "node:fs";
const path="wrangler.jsonc";
let config=fs.readFileSync(path,"utf8");
config=config.replace('https://REPLACE_WITH_HOSTPILOT_DOMAIN',process.env.APP_URL);
config=config.replace('"OWNER_IDS": ""','"OWNER_IDS": "'+process.env.OWNER_IDS+'"');
config=config.replace(/"APP_URL":\s*"[^"]*"/,'"APP_URL": "'+process.env.APP_URL+'"');
fs.writeFileSync(path,config);
NODE

WEBHOOK_SECRET="$(openssl rand -hex 32)"
echo "Saving bot credentials as protected Cloudflare Worker secrets..."
printf '%s' "$BOT_TOKEN" | npx wrangler secret put BOT_TOKEN
printf '%s' "$WEBHOOK_SECRET" | npx wrangler secret put BOT_WEBHOOK_SECRET

echo "Applying D1 migrations..."
npm run db:migrate:remote

echo "Building and deploying HostPilot..."
npm run deploy

echo "Registering Telegram webhook and Mini App menu..."
curl -fsS -X POST "https://api.telegram.org/bot${BOT_TOKEN}/setWebhook" \
  --data-urlencode "url=${APP_URL}/bot" \
  --data-urlencode "secret_token=${WEBHOOK_SECRET}" \
  --data-urlencode 'allowed_updates=["message"]' >/dev/null

BOT_MENU="$(APP_URL="$APP_URL" node --input-type=module -e 'console.log(JSON.stringify({menu_button:{type:"web_app",text:"Open HostPilot",web_app:{url:process.env.APP_URL}}}))')"
curl -fsS -X POST "https://api.telegram.org/bot${BOT_TOKEN}/setChatMenuButton" \
  -H 'content-type: application/json' -d "$BOT_MENU" >/dev/null

BOT_COMMANDS='{"commands":[{"command":"start","description":"Start HostPilot and open the app"},{"command":"app","description":"Open the HostPilot Mini App"},{"command":"help","description":"Show HostPilot help"},{"command":"admin","description":"Open HostPilot administration"}]}'
curl -fsS -X POST "https://api.telegram.org/bot${BOT_TOKEN}/setMyCommands" \
  -H 'content-type: application/json' -d "$BOT_COMMANDS" >/dev/null

echo
echo "HostPilot deployment and Telegram bot setup completed."
echo "App: $APP_URL"
echo "Webhook: ${APP_URL}/bot"
echo "Next: register each VPS in the HostPilot Admin panel and install its agent."
echo "Keep BOT_TOKEN and BOT_WEBHOOK_SECRET private. They are not written into Git."
unset BOT_TOKEN WEBHOOK_SECRET
