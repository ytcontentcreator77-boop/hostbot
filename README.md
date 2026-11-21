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
The development branch now includes chunked individual-file uploads and downloads, dependency-aware project rebuilds with container logs, VPS tar backup/restore and retention cleanup, optional GitHub branch backup/restore, admin JSON export/import, announcement and scheduled campaign management, coupon management, payment-method administration, customer top-up requests, payment review and plan resource/price editing. GitHub backups require a `GITHUB_TOKEN` configured only in the VPS agent environment. The previous control-plane, migration and agent checks passed; CI is running again after the new bot/setup changes. Real-VPS integration testing is still pending, so this branch is not production-certified. See [the roadmap](docs/ROADMAP.md) and [deployment guide](docs/DEPLOYMENT.md).

## Quick start
See [the first-time setup guide](docs/SETUP.md). The interactive setup command is `npm run setup`; it configures Cloudflare D1, protected Telegram bot secrets, migrations, deployment, webhook, Mini App menu button and bot commands. It asks for your real HTTPS app URL and owner Telegram ID; it never writes the bot token into the repository.

The VPS agent is a separate Node.js service under `agent/`. It is designed for compatible Linux VPS machines from any provider, using Docker and outbound HTTPS heartbeats. Provider-specific cloud APIs are not required. The agent supports outbound heartbeats and leased task polling/acknowledgement. Production hardening, resource isolation and real-VPS validation remain unfinished.

Do not accept customer workloads or payments until security hardening, payment-provider integration and isolated real-VPS testing are complete.
