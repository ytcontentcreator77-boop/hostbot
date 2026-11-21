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
HostPilot uses a provider-neutral VPS node model: servers from Hetzner, DigitalOcean, Vultr, Linode/Akamai, AWS, Google Cloud, Azure, Oracle Cloud, Contabo, OVH, or another provider can be registered, provided the machine supports a compatible Linux distribution, Docker and outbound HTTPS. Provider names are metadata; HostPilot does not depend on a provider-specific API. Each VPS runs its own agent and Docker engine. In the Admin Panel/API, register a node with `POST /api/admin/servers` (name, provider, region, optional HTTPS endpoint); copy the one-time `agent_token` from the response. On that VPS, build the agent with `cd agent && npm install && npm run build`, configure rootless Docker and a dedicated OS account, then set `HOSTPILOT_AGENT_SECRET`, `PROJECT_ROOT`, `DOCKER_SOCKET`, `CONTROL_PLANE_URL` and `NODE_TOKEN` using `agent/.env.example`. The agent sends an authenticated outbound heartbeat every 30 seconds; no inbound public port is required for registration/health reporting. Heartbeats update the server's provider-neutral capacity record (CPU, RAM, OS, architecture and Node version). Admin inventory is available at `GET /api/admin/servers`. Customer workloads still run in isolated containers on VPS disks; the control plane does not execute customer code.

## No R2
There is intentionally no R2 binding, bucket, SDK, upload path or deployment step. D1 stores metadata; project files and media are stored on VPS disks.

## Current implementation boundary
This repository is still an early development scaffold. Telegram initData validation, basic profile/plans/dashboard endpoints, owner/admin gating and webhook secret validation are present. The VPS inventory API, one-time node token registration and outbound agent heartbeat are implemented as an initial multi-provider foundation. Worker-to-agent job dispatch, per-node command authentication, automatic project scheduling, disk quota enforcement and full node lifecycle UI are not complete. The setup wizard, full project lifecycle, complete customer/admin UI, payment integrations and preserved announcement/campaign/bonus/coupon modules are also not complete. Do not use it for paying customers until these are implemented and security-tested.
