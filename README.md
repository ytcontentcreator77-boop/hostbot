# HostPilot

Telegram-based Python and Node.js cloud hosting control plane.

## Architecture
- Cloudflare Worker: Telegram webhook, authenticated API and Mini App delivery.
- Cloudflare D1: users, plans, subscriptions, wallet ledger, projects and control-plane metadata.
- Provider-neutral VPS fleet: register compatible Linux VPS machines from any provider; each runs a HostPilot agent and isolated Python/Node.js containers. Project files, media and backups stay on VPS disks.
- GitHub Actions: control-plane and VPS-agent validation.

**Supported billing currencies: USD ($) and INR (₹) only. USDT and other cryptocurrencies are not supported.** Each user has separate USD and INR wallet balances; no automatic conversion occurs.

**No Cloudflare R2 is used.** No HTML/static-site hosting or SMM features are included.

## Current development status
The repository contains an early customer Mini App, Worker API foundations, database migrations, immutable wallet-ledger triggers, payment request/review foundations and an experimental VPS agent. It is not production-ready. See [the roadmap](docs/ROADMAP.md) and [deployment guide](docs/DEPLOYMENT.md).

## Quick start
1. Install Node.js 24+ and run `npm install`.
2. Create a Cloudflare D1 database and set its ID in `wrangler.jsonc`.
3. Configure `BOT_TOKEN` and `BOT_WEBHOOK_SECRET` as Worker secrets.
4. Set `OWNER_IDS` and `APP_URL`.
5. Apply migrations with `npm run db:migrate:remote`.
6. Run `npm run deploy`.

The VPS agent is a separate Node.js service under `agent/`. It is designed for compatible Linux VPS machines from any provider, using Docker and outbound HTTPS heartbeats. Provider-specific cloud APIs are not required. The current enrollment/heartbeat is only an initial foundation; remote job dispatch and production hardening remain unfinished.

Do not accept customer workloads or payments until the remaining security, runtime, UI, setup and integration work is complete and tested.
