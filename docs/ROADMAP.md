# HostPilot implementation roadmap

## Implemented foundations (not yet production-certified)
- [x] Cloudflare Worker + Vite/Preact repository foundation
- [x] D1 core schema for users, plans, wallets, ledger, subscriptions, projects, VPS nodes and audit logs
- [x] Expanded schema for deployments, runtime instances, project files, encrypted-env storage fields, backups, VPS health, payments, localization, announcements, campaigns, bonuses, coupons, tickets, broadcasts, referrals, staff permissions and notifications
- [x] Seeded 28 language entries and Free/Silver/Platinum/Gold plan defaults
- [x] Telegram Mini App initData HMAC validation
- [x] Basic profile, plans and dashboard APIs
- [x] Basic customer Mini App with Dashboard, Projects, Plans, Top Up and Profile navigation
- [x] Enabled language list and language preference APIs
- [x] Default wallet and Free subscription provisioning on first authenticated Mini App visit
- [x] Owner/admin authorization foundation and admin overview API
- [x] Telegram webhook secret-header verification
- [x] Wallet ledger service with immutable entries, balance triggers, separate USD ($) and INR (₹) balances only, currency allowlist triggers and idempotent deposit approval foundation
- [x] Payment request creation and admin wallet adjustment/deposit review API foundations
- [x] Experimental VPS agent prototype with HMAC signatures, replay protection, runtime image allowlist and constrained Docker containers
- [x] Provider-neutral multi-VPS inventory API, one-time node enrollment tokens and outbound agent heartbeat with CPU/RAM/OS capacity metadata
- [x] CI workflow configured to typecheck/build the Worker frontend and compile the VPS agent
- [x] No R2 dependency; customer files/media/backups are assigned to VPS storage

## Still remaining before production
- [ ] Confirm CI after dependency alignment; add unit, migration and integration tests
- [ ] Setup wizard, bot identity/profile/menu setup, webhook registration automation and permanent installer lock
- [ ] Complete paginated 28-language picker, translation import/overrides and synchronized bot/Mini App localization
- [ ] Full customer dashboard metrics, onboarding checklist, notifications and Telegram-native interactions
- [ ] Project CRUD, ZIP/file uploads, path traversal and zip-bomb validation, encrypted .env management and dependency build pipeline
- [ ] Production VPS agent command channel, signed Worker-to-agent client, mTLS/WireGuard deployment and key rotation
- [ ] Harden container isolation: rootless Docker, AppArmor/seccomp profiles, egress filtering, disk quotas, image pinning/scanning and abuse detection
- [ ] Python/Node dependency installation, build caching, logs/console streaming, metrics, health checks, crash-loop controls and resource reporting
- [ ] VPS scheduler, capacity-aware placement, node health, live migration and failover
- [ ] VPS-backed file manager, project backups, retention, restore, export/import and off-node replication
- [ ] Full responsive Admin Panel with granular staff roles, permissions and complete audit logging
- [ ] Plans editor for price, currency, duration, project count, CPU, RAM, storage, upload, file, dependency and runtime-version limits
- [ ] Complete wallet UI, payment-method editor, proof uploads, receipts, refunds and verified eSewa/Khalti/UPI/Stars/manual gateways
- [ ] Subscription lifecycle, renewal, expiry notifications, grace periods, suspension and vouchers
- [ ] Fully working announcement, campaign, bonus, coupon, broadcast and backup admin interfaces (schema exists; UI/workflows remain)
- [ ] Referrals, support ticket threads, FAQ, Terms and notifications
- [ ] Automated D1 provisioning/migrations, production deploy workflow and tested rollback procedures
- [ ] End-to-end security testing on a real Telegram bot and isolated VPS nodes

No HTML/static-site hosting and no SMM functionality are in scope. Customer workloads must never execute inside Cloudflare Workers. The current code is a development foundation, not ready for public or paid workloads.


## Terminal access
- [x] Plan-level terminal entitlement field and admin APIs; Silver, Platinum and Gold default to enabled, Free defaults to disabled.
- [x] Admin per-user override can enable or disable access regardless of plan; `null` restores plan-based access.
- [x] Mini App only shows the Terminal tab when entitlement is granted; Termux/OpenSSH setup guidance is shown.
- [x] Experimental per-project SSH public-key registration/revocation, node-side key sync, and SSH2 gateway restricted to a single assigned project container; no host shell, SSH exec request or SFTP subsystem.
- [ ] Real-VPS SSH integration/security testing, project-level egress isolation, disk quotas, session audit trail, production key rotation and hostile-workload sandbox certification.
