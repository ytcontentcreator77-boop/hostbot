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
- [x] Durable leased task queue with per-node bearer authentication, lease expiry/retry and result acknowledgement
- [x] Customer project creation API and Mini App form with plan project-count/runtime checks and automatic healthy-VPS assignment
- [x] Plan-limited ZIP uploads staged in temporary D1 chunks, transferred only to the assigned VPS agent, then removed from D1 after successful deployment
- [x] ZIP extraction rejects path traversal, symlinks, encrypted/unsupported archives, oversized entries and excessive expansion; detects Python entry files, requirements.txt/pyproject.toml and Node package.json/start scripts
- [x] VPS agent outbound task polling and constrained container create action; new projects receive an isolated placeholder container
- [x] CI workflow configured to typecheck/build the Worker frontend and compile the VPS agent
- [x] No R2 dependency; customer files/media/backups are assigned to VPS storage

## Still remaining before production
- [ ] Confirm CI after dependency alignment; add unit, migration and integration tests
- [ ] Setup wizard, bot identity/profile/menu setup, webhook registration automation and permanent installer lock
- [ ] Complete paginated 28-language picker, translation import/overrides and synchronized bot/Mini App localization
- [ ] Full customer dashboard metrics, onboarding checklist, notifications and Telegram-native interactions
- [ ] Complete project CRUD, ZIP/file uploads, path traversal and zip-bomb validation, encrypted .env management and dependency build pipeline
- [ ] Harden task channel with idempotent execution, mTLS/WireGuard deployment, node key rotation and operational alerting
- [ ] Harden container isolation: rootless Docker, AppArmor/seccomp profiles, egress filtering, disk quotas, image pinning/scanning and abuse detection
- [x] Initial VPS-backed project file browser/editor, project start/stop/restart controls and bounded container log retrieval through leased agent tasks
- [x] Plan-limited chunked individual-file upload from the Mini App through temporary D1 chunks to the assigned VPS agent; per-file limits are enforced from the active plan (Free default 10 MB, Gold default 500 MB).
- [x] Bounded chunked large-file downloads; [ ] directory upload, resumable upload recovery/expiry cleanup, upload integrity hashes, pagination and full file-manager UX hardening
- [x] Python/Node dependency installation is invoked by project startup/rebuild and visible in container logs; [ ] build caching, metrics, health checks, crash-loop controls and resource reporting
- [ ] Advanced VPS scheduler with resource-aware placement, quotas, node health, live migration and failover
- [x] Project backup create/list/restore task pipeline and audited admin backup inventory/restore controls (archives remain on VPS disks)
- [x] Scheduled VPS-side backup retention cleanup: expired archives are queued to their owning agent, deleted from disk, and marked deleted/failed in D1
- [x] Admin JSON export/import for supported administrative data; [x] optional VPS-side GitHub branch backup/restore; [ ] off-node replication of all VPS data
- [x] Admin overview dashboard with live user/project/payment/VPS counts
- [x] Admin customer search by Telegram ID, username or name, with audited suspend/reactivate controls
- [ ] Full responsive Admin Panel with granular staff roles, permissions and complete audit logging
- [x] Admin editor for per-plan project count, file count, upload size, CPU, RAM and VPS storage limits
- [x] Admin plan editor for price, currency, duration and resource limits; [ ] dependency and runtime-version allowlist editor
- [x] Admin payment-method editor, customer top-up request flow and payment review; [ ] proof uploads, receipts, refunds and verified eSewa/Khalti/UPI/Stars/manual gateways
- [ ] Subscription lifecycle, renewal, expiry notifications, grace periods, suspension and vouchers
- [x] Announcement management, scheduled audience campaigns, coupon management and admin data backup interfaces; [ ] bonus and broadcast management
- [ ] Referrals, support ticket threads, FAQ, Terms and notifications
- [ ] Automated D1 provisioning/migrations, production deploy workflow and tested rollback procedures
- [ ] End-to-end security testing on a real Telegram bot and isolated VPS nodes

No HTML/static-site hosting and no SMM functionality are in scope. Customer workloads must never execute inside Cloudflare Workers. The current code is a development foundation, not ready for public or paid workloads.


## Terminal access
- [x] Plan-level terminal entitlement field and admin APIs; Silver, Platinum and Gold default to enabled, Free defaults to disabled.
- [x] Admin per-user override can enable or disable access regardless of plan; `null` restores plan-based access.
- [x] Mini App only shows the Terminal tab when entitlement is granted; Termux/OpenSSH setup guidance is shown.
- [x] Experimental per-project SSH public-key registration/revocation with lifecycle audit events, node-side key sync, and SSH2 gateway restricted to a single assigned project container; no host shell, SSH exec request or SFTP subsystem.
- [ ] Real-VPS SSH integration/security testing, project-level egress isolation, disk quotas, session audit trail, production key rotation and hostile-workload sandbox certification.
