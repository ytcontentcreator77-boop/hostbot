# HostPilot deployment (development foundation)

## Cloudflare control plane
1. Install Node.js 24+ and run `npm install`.
2. Create D1: `npx wrangler d1 create hostpilot`.
3. Put the returned database ID in `wrangler.jsonc` instead of `REPLACE_WITH_D1_DATABASE_ID`.
4. Set secrets: `npx wrangler secret put BOT_TOKEN` and `npx wrangler secret put BOT_WEBHOOK_SECRET`.
5. Set `OWNER_IDS` to the owner's numeric Telegram ID and `APP_URL` to the final HTTPS Worker/custom-domain URL in `wrangler.jsonc`.
6. Apply all migrations, including the agent task queue and lease fields: `npm run db:migrate:remote`.
7. Build and deploy: `npm run deploy`.
8. Register the webhook using Telegram `setWebhook`, URL `https://YOUR-DOMAIN/bot`, and the same secret as `BOT_WEBHOOK_SECRET` in the `secret_token` parameter. Telegram sends it in `X-Telegram-Bot-Api-Secret-Token`.

## VPS workload and file storage
HostPilot uses a provider-neutral VPS node model: servers from Hetzner, DigitalOcean, Vultr, Linode/Akamai, AWS, Google Cloud, Azure, Oracle Cloud, Contabo, OVH, or another provider can be registered, provided the machine supports a compatible Linux distribution, Docker and outbound HTTPS. Provider names are metadata; HostPilot does not depend on a provider-specific API. Each VPS runs its own agent and Docker engine. In the Admin Panel/API, register a node with `POST /api/admin/servers` (name, provider, region, optional HTTPS endpoint); copy the one-time `agent_token` from the response. On that VPS, build the agent with `cd agent && npm install && npm run build`, configure rootless Docker and a dedicated OS account, then set `HOSTPILOT_AGENT_SECRET`, `PROJECT_ROOT`, `DOCKER_SOCKET`, `CONTROL_PLANE_URL` and `NODE_TOKEN` using `agent/.env.example`. The agent sends an authenticated outbound heartbeat every 30 seconds and polls the Worker for leased project tasks every five seconds; task execution is acknowledged using the lease token. No inbound agent HTTP port is required for registration, health reporting or task dispatch. Heartbeats update the server's provider-neutral capacity record (CPU, RAM, OS, architecture and Node version). Admin inventory is available at `GET /api/admin/servers`. Customer workloads still run in isolated containers on VPS disks; the control plane does not execute customer code.

## No R2
There is intentionally no R2 binding, bucket, SDK, upload path or deployment step. D1 stores metadata; project files and media are stored on VPS disks.

## Current implementation boundary
This repository is still an early development scaffold. Telegram initData validation, basic profile/plans/dashboard endpoints, owner/admin gating and webhook secret validation are present. The VPS inventory API, one-time node token registration and outbound agent heartbeat are implemented as an initial multi-provider foundation. The initial leased task channel and basic automatic VPS assignment are implemented. New projects currently receive an isolated placeholder container (`sleep infinity`); ZIP upload, file browsing, dependency installation/builds, real startup commands, logs, resource-aware placement and disk quota enforcement are not complete. The setup wizard, full project lifecycle, complete customer/admin UI, payment integrations and preserved announcement/campaign/bonus/coupon modules are also not complete. Do not use it for paying customers until these are implemented and security-tested.

## Project-only Termux SSH (experimental)
1. Apply all D1 migrations with `npm run db:migrate:remote` after deploying the updated Worker (including `0011_agent_task_queue.sql`, `0012_agent_task_leases.sql` and `0013_project_zip_uploads.sql
- `0014_plan_file_size_limits.sql``).
2. Configure each VPS agent with `TERMINAL_SSH_BIND=0.0.0.0`, `TERMINAL_SSH_PORT=2222`, and a persistent protected `TERMINAL_SSH_HOST_KEY` path. Keep `HOSTPILOT_AGENT_SECRET`, `NODE_TOKEN`, and the agent HTTP API private.
3. When registering a VPS using `POST /api/admin/servers`, include `ssh_host` (the public DNS name/IP users will connect to) and `ssh_port` (normally 2222). Example body: `{"name":"node-1","provider":"custom","ssh_host":"vps.example.com","ssh_port":2222}`. The enrollment token is still shown only once.
4. Allow inbound TCP 2222 to the SSH gateway in the VPS firewall. Do not expose agent HTTP port 8788. Prefer a VPN or source-IP allowlist for the SSH port.
5. In the Mini App, entitled users choose a project, generate an Ed25519 key in Termux, and register only the `.pub` public key. Termux connects with the displayed `ssh -p PORT hp_PROJECTUUID@HOST` command. The private key remains on the user's phone.
6. SSH access is project-container-only. The gateway rejects SSH exec requests and SFTP/subsystems; it offers an interactive shell only inside the assigned running container. Revoked keys are removed after the next key-sync poll (normally within 15 seconds); authentication fails closed when key sync is stale.
7. Keep a persistent backup of the SSH host key. Replacing it changes the SSH server identity.

This is an experimental feature. It has not yet been certified on a real VPS or audited against hostile customer workloads. Container-root access is limited to the project's container and relies on rootless Docker and container hardening; it is not a substitute for a production sandbox or egress/disk isolation.

## Project creation (early foundation)
1. Deploy the latest Worker and apply all D1 migrations.
2. Register at least one enabled VPS and wait until its heartbeat reports `healthy`.
3. Keep the VPS agent running with `CONTROL_PLANE_URL` and the one-time `NODE_TOKEN`; it polls the control plane for leased tasks.
4. Customers can create a Python or Node.js project from the Mini App. The Worker checks the active plan's project limit/runtime allowance, assigns a healthy node and queues a create task.
5. The current create task provisions a constrained placeholder container only. It does not yet upload application source, install dependencies or run a customer entry file. Do not describe this as a deployed app until the file/build pipeline is implemented.

## ZIP project upload and automatic detection
1. Create a project in the Mini App and wait for the initial project container task to finish.
2. Open the project card, select a `.zip` archive, then choose **Upload & deploy ZIP**. The upload is checked against the active plan's `max_upload_bytes` (and a 20 MB platform ceiling).
3. The Worker temporarily stages the archive as 256 KB D1 chunks. Only the VPS node assigned to that project can download those chunks using its agent token. After successful extraction/deployment, the temporary chunk rows are deleted; the extracted project files live on that VPS disk.
4. ZIP extraction rejects path traversal, symlinks, encrypted/unsupported entries, files above 20 MB, archives with more than 500 entries, total expansion above 100 MB and compression ratios above 100:1. A common top-level folder is stripped when present.
5. Python detection looks for `main.py`, `bot.py`, `app.py`, `run.py` or `index.py`. It installs `requirements.txt` or a `pyproject.toml` project when present. Node detection reads `package.json` `main` and `scripts.start`, or falls back to `index.js`, `main.js`, `app.js`, `server.js` or `src/index.js`; it runs npm install when a package manifest is present.
6. The project card shows the detected entry point and dependency manifests. Projects without a recognized entry point fail deployment and need a supported entry file or package start script.


### Per-plan individual file-size limits

Migration `0014_plan_file_size_limits.sql` adds `plans.max_file_bytes`, separate from the ZIP deployment limit. Defaults: Free 10 MB, Silver 50 MB, Platinum 100 MB, Gold 500 MB. Admins can change the per-file value up to 500 MB in the plan resource editor. This migration configures policy only; the current file-manager JSON task transport still has a 64 KB file read/write cap. Do not advertise large individual-file uploads as operational until the direct-to-VPS chunked upload gateway is deployed and tested. ZIP deployment remains separately capped at 20 MB while it uses D1 staging.


## Chunked individual-file uploads (new; integration testing required)
The project workspace now uploads individual files in 256 KiB chunks. The Worker authenticates Telegram Mini App initData, checks the user's active plan `max_file_bytes`, validates the relative project path, stores temporary chunks in D1, and queues a task only after every chunk is present. The assigned VPS agent downloads the chunks sequentially and streams them into a temporary file under that project's directory; it checks the plan's per-file, file-count and storage limits, verifies the final byte count, then atomically renames the temporary file into place. Temporary D1 chunks are deleted when the agent acknowledges success or failure. The default per-file limits from migration `0014_plan_file_size_limits.sql` are Free 10 MB, Silver 50 MB, Platinum 100 MB and Gold 500 MB; administrators can adjust the plan value up to 500 MB.

This is not yet production-certified. The D1 staging approach temporarily consumes database storage and creates one request per chunk. Large-file downloads and editor previews still use the older 64 KiB read limit; do not promise full-size downloads until chunked download transport is implemented. Test upload interruption, duplicate chunk retries, storage quotas, concurrent uploads and real VPS disk behavior before accepting customer workloads.
