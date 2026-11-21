# HostPilot

Telegram-based Python and Node.js hosting control plane.

## Architecture
- Cloudflare Worker: Telegram webhook, authenticated API and Mini App delivery.
- Cloudflare D1: metadata, users, plans, billing ledger and project records.
- VPS nodes: isolated customer Python/Node.js workloads and all uploaded files/backups.
- GitHub Actions: validation and deployment.

**No Cloudflare R2 is used.** Project files, uploads, media and backups are stored on VPS disk through the HostPilot node agent. Customer code must never execute inside a Worker.

## Current status
This repository is the initial foundation, not a production-ready hosting service. VPS agent/container isolation, full billing gateways, admin workflows, localization bundles and the complete Mini App must be implemented and tested before accepting customers.

## Setup
1. Install Node.js 24+.
2. Run `npm install`.
3. Create a Cloudflare D1 database and place its ID in `wrangler.jsonc`.
4. Configure `BOT_TOKEN` as a Worker secret and `OWNER_IDS` as a comma-separated Worker variable.
5. Apply migrations with `npm run db:migrate:remote`.
6. Build and deploy with `npm run deploy`.

See `docs/DEPLOYMENT.md` and `docs/ROADMAP.md`.