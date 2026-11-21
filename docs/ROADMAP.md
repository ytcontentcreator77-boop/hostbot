# HostPilot implementation roadmap

- [x] Initial Worker + Vite/Preact repository foundation
- [x] D1 starter schema for users, plans, wallets, ledger, subscriptions, projects, VPS nodes and audit logs
- [x] Telegram Mini App initData HMAC validation foundation
- [ ] Setup wizard, webhook secret validation, bot menu and profile configuration
- [ ] 20+ languages, editable translations and onboarding flow
- [ ] Customer dashboard, projects, file manager, logs and deployment history
- [ ] Admin panel and granular role permissions
- [ ] Preserve announcements, campaigns, bonuses, coupons, broadcasts, backup tools and support
- [ ] Plans/pricing editor with CPU, RAM, storage, upload and runtime quotas
- [ ] Immutable/idempotent wallet ledger and payment integrations
- [ ] VPS agent with authenticated mutual TLS, container isolation and hard resource/network limits
- [ ] Secure VPS file storage, upload validation, backups and restore
- [ ] Multi-VPS scheduler, health monitoring and migration
- [ ] GitHub Actions CI/CD, automated migrations and integration/security tests

Never run customer Python or Node.js code inside a Cloudflare Worker. No HTML/static-site hosting and no SMM functionality are part of HostPilot.