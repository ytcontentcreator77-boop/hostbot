# HostPilot first-time setup

## Before running setup
- A Cloudflare account with Workers and D1 enabled.
- Node.js 24+, npm, curl and OpenSSL.
- A Telegram bot created with [@BotFather](https://t.me/BotFather).
- A public HTTPS app URL. Use your Cloudflare Workers subdomain (for example `https://hostpilot.YOUR-SUBDOMAIN.workers.dev`) or a custom domain such as `https://hostpilot.example.com`. A custom domain must already be added to the Cloudflare zone and attached to the Worker.

## One-command setup

Clone the repository and check out the development branch containing the HostPilot implementation:

```bash
git clone https://github.com/ytcontentcreator77-boop/hostbot.git
cd hostbot
git checkout feature/hosting-admin-completion
npm run setup
```

The setup script asks for the public HTTPS app URL and owner Telegram numeric ID, then securely prompts for the bot token without echoing it. It validates the token with Telegram, creates the D1 database if the config still has its placeholder, writes the D1 ID and public app URL into `wrangler.jsonc`, stores `BOT_TOKEN` and a generated `BOT_WEBHOOK_SECRET` as Cloudflare Worker secrets, applies migrations, deploys the Worker/Mini App, registers the Telegram webhook at `/bot`, and configures the bot's Mini App menu button and commands.

You must be logged into Cloudflare first. If not, run `npx wrangler login` and then run `npm run setup` again. Review the generated `wrangler.jsonc` before committing it; it contains public configuration only, never the bot token.

## Manual setup

If you prefer to configure everything manually:

1. Set the D1 database ID and `APP_URL` in `wrangler.jsonc`; set `OWNER_IDS` to the owner's numeric Telegram ID.
2. Store secrets with `npx wrangler secret put BOT_TOKEN` and `npx wrangler secret put BOT_WEBHOOK_SECRET` (use a random 32-byte hex value for the webhook secret).
3. Run `npm install`, `npm run db:migrate:remote`, and `npm run deploy`.
4. Register Telegram's webhook URL as `https://YOUR-APP-DOMAIN/bot` with the same webhook secret in Telegram's `secret_token` field.
5. Configure the bot's menu button with `setChatMenuButton` using a `web_app` URL equal to `APP_URL`.

The Worker verifies Telegram's `X-Telegram-Bot-Api-Secret-Token` header before processing bot updates. The bot supports `/start`, `/app`, `/help`, and owner/admin-gated `/admin`.

## VPS agent setup

After the app is deployed, open the Mini App as the owner, go to Admin, register each VPS, and copy its one-time node token. On each compatible Linux VPS, install Docker and Node.js 22+, configure the agent using `agent/.env.example`, and set `CONTROL_PLANE_URL` to the exact same public app URL. Keep the agent HTTP API private; the agent makes outbound HTTPS connections to the Worker.

## Security

Never commit bot tokens, webhook secrets, VPS node tokens, GitHub tokens, payment credentials or SSH private keys. Store secrets using Wrangler/Cloudflare secrets or the protected environment of the VPS agent. If a token was ever committed or shared publicly, revoke it with its provider and generate a replacement.
