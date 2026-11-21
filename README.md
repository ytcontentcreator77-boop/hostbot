# HostPilot

Telegram-based Python and Node.js hosting control plane.

- Cloudflare Worker: Mini App delivery, API and Telegram webhook.
- Cloudflare D1: users, plans, subscriptions, payments, projects and audit metadata.
- VPS nodes: isolated Python/Node.js workloads and all customer files, media and backups.
- GitHub Actions: CI validation.

**No Cloudflare R2 is used.** Files and backups are stored on VPS disk through the HostPilot node agent.

This is an initial scaffold, not a production-ready hosting service. See `docs/DEPLOYMENT.md` and `docs/ROADMAP.md` for setup and remaining work.