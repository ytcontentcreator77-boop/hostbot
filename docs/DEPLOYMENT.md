# HostPilot deployment (development foundation)

## Cloudflare control plane
1. Install Node.js 24+ and run `npm install`.
2. Create D1: `npx wrangler d1 create hostpilot`.
3. Put the returned database ID in `wrangler.jsonc` instead of `REPLACE_WITH_D1_DATABASE_ID`.
4. Set secrets: `npx wrangler secret put BOT_TOKEN` and `npx wrangler secret put BOT_WEBHOOK_SECRET`.
5. Set `OWNER_IDS` to the owner's numeric Telegram ID and `APP_URL` to the final HTTPS Worker/custom-domain URL in `wrangler.jsonc`.
6. Apply migrations: `npm run db:migrate:remote`.
7. Build and deploy: `npm run deploy`.
8. Register the webhook using Telegram `setWebhook`, URL `https://YOUR-DOMAIN/bot`, and the same secret as `BOT_WEBHOOK_SECRET` in the `secret_token` parameter. Telegram sends it in `X-Telegram-Bot-Api-Secret-Token`.

## VPS workload and file storage
Provision Ubuntu VPS nodes separately. The experimental agent prototype is under `agent/`; build it with `cd agent && npm install && npm run build`. Configure rootless Docker, a dedicated OS account, `HOSTPILOT_AGENT_SECRET`, `PROJECT_ROOT` and `DOCKER_SOCKET`. Run it on loopback behind a private VPN and mutual-TLS reverse proxy. Customer Python and Node.js code must run in isolated containers managed by this agent. Project uploads, source files, media, logs and backups are stored on VPS disks with per-user quotas and off-node backup policy. Never execute customer code inside Cloudflare Workers.

## No R2
There is intentionally no R2 binding, bucket, SDK, upload path or deployment step. D1 stores metadata; project files and media are stored on VPS disks.

## Current implementation boundary
This repository is still an early development scaffold. Telegram initData validation, basic profile/plans/dashboard endpoints, owner/admin gating and webhook secret validation are present. The setup wizard, VPS agent, container sandbox, full project lifecycle, complete customer/admin UI, payment integrations and preserved announcement/campaign/bonus/coupon modules are not complete. Do not use it for paying customers until these are implemented and security-tested.
