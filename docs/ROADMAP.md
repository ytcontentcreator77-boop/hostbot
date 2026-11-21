# HostPilot implementation roadmap

## Completed foundations
- [x] Initial Worker + Vite/Preact repository foundation
- [x] D1 base schema for users, plans, wallets, ledger, subscriptions, projects, VPS nodes and audit logs
- [x] Telegram Mini App initData HMAC validation
- [x] Expanded D1 schema for files, deployments, runtime instances, encrypted-env storage fields, backups, VPS health, payments, localization, announcements, campaigns, bonuses, coupons, tickets, broadcasts, referrals, staff permissions and notifications
- [x] Seeded 28 language entries and Free/Silver/Platinum/Gold plan defaults
- [x] Basic authenticated profile, plans and dashboard API endpoints
- [x] Owner/admin authorization helper and admin overview endpoint
- [x] Telegram webhook secret-header validation
- [x] No R2 dependency; file storage is reserved for VPS disks

## Remaining implementation
- [ ] Setup wizard, bot identity/profile/menu setup, webhook registration automation and permanent installer lock
- [ ] Complete paginated 28-language picker, translation import/overrides and bot/Mini App localization
- [ ] Customer dashboard UI and fixed bottom navigation
- [ ] Project CRUD, ZIP/file uploads, path/zip-bomb validation, .env encryption and dependency build pipeline
- [ ] HostPilot VPS agent with authenticated signed requests, replay protection and node enrollment
- [ ] Docker sandbox with non-root containers, CPU/RAM/PID/disk/network quotas, seccomp/AppArmor and no privileged mode
- [ ] Runtime process manager for Python and Node.js, logs, health checks, crash-loop protection and restart policies
- [ ] VPS scheduler, capacity-aware placement, node health, migration and failover
- [ ] VPS-backed file storage, project backups, retention, restore and backup export/import
- [ ] Full Admin Panel with role-based permissions and audit logging
- [ ] Plans editor for price, duration, project count, CPU, RAM, storage, uploads, files, runtime versions and network limits
- [ ] Wallet ledger service with atomic/idempotent credits/debits; payment methods and manual/online gateway verification
- [ ] Subscription lifecycle, expiry jobs, grace periods, renewals and vouchers
- [ ] Restore and adapt announcements, campaigns, bonuses, coupons, broadcasts and existing admin tools as working UI/API modules
- [ ] Referrals, support ticket threads, FAQ and Terms
- [ ] GitHub Actions deployment workflow, automated D1 provisioning/migrations, tests and security checks
- [ ] End-to-end testing on real Telegram bot and isolated VPS nodes

No HTML/static-site hosting and no SMM functionality are in scope. Customer workloads must never execute inside Cloudflare Workers.
