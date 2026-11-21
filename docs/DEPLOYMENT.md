# HostPilot deployment (initial foundation)

## Cloudflare control plane
1. Create a Cloudflare account and install Node.js 24+ locally.
2. Run `npm install`.
3. Create a D1 database: `npx wrangler d1 create hostpilot`.
4. Copy the returned database ID into `wrangler.jsonc` in place of `REPLACE_WITH_D1_DATABASE_ID`.
5. Set the bot token: `npx wrangler secret put BOT_TOKEN`.
6. Set `OWNER_IDS` in Worker variables to the owner's numeric Telegram ID.
7. Apply the schema: `npm run db:migrate:remote`.
8. Build and deploy: `npm run deploy`.
9. Set the Telegram webhook to `https://YOUR-WORKER-DOMAIN/bot` using Telegram's setWebhook API.

## VPS workload/storage plane
Provision Ubuntu VPS nodes separately. Customer workloads must run in isolated containers managed by a dedicated HostPilot agent. Store project files, uploads, media and backups on VPS disks with per-user quotas and off-node backups. Do not execute customer code in Cloudflare Workers.

## No R2
This project intentionally has no R2 binding, bucket, SDK or R2 deployment step. D1 stores metadata only; large files live on VPS storage.

## Important
The current repository is an early scaffold. The webhook's Mini App URL is a placeholder, the setup wizard is not yet implemented, and the VPS agent, container sandbox, complete UI, payment integrations and full admin features are not production-ready. Do not expose it to paying users until these components and security tests are complete.