# HostPilot VPS Node Agent (experimental)

This agent is an early isolated-container execution prototype. It is not production-ready and must not be exposed directly to the public internet.

## Design
- Bind to loopback only; put it behind a TLS reverse proxy with mutual TLS or a private WireGuard network.
- Set a high-entropy `HOSTPILOT_AGENT_SECRET`; Worker requests use HMAC-SHA256 over timestamp, nonce, method, URL path and SHA-256 body hash.
- Nonces are kept briefly to reject replayed requests.
- Use rootless Docker and a dedicated OS account. The agent's Docker socket is effectively privileged to that Docker daemon.
- Customer containers run as root only inside a rootless Docker user namespace (not host root), drop Linux capabilities, use no-new-privileges, read-only root filesystem, bounded memory/CPU/PIDs and capped Docker logs. Keep the agent account dedicated to HostPilot.
- Project directories are derived from UUIDs beneath `PROJECT_ROOT`; clients cannot supply host paths.
- Runtime images are allowlisted. No HTML/static-site hosting.

## Install
1. Install Node.js 22+ and rootless Docker on an Ubuntu VPS.
2. Create a dedicated project root: `sudo install -d -m 0770 -o hostpilot -g hostpilot /srv/hostpilot/projects`.
3. Copy `.env.example` values into a protected environment file; set `HOSTPILOT_AGENT_SECRET`, `CONTROL_PLANE_URL` and the one-time `NODE_TOKEN` generated when an administrator registers this VPS in HostPilot. Never commit either secret.
4. Run `npm install`, `npm run build`, then run the compiled server under systemd.
5. Expose it only over private networking / mTLS; do not open port 8788 publicly.

## Important limitations
The prototype now supports provider-neutral registration through an outbound authenticated heartbeat to the HostPilot Worker. It can run on compatible Linux VPS machines from any hosting provider; the provider label is informational, not a vendor integration. It still supports start/stop/restart/delete/status only and does not yet implement Worker-to-agent job dispatch, ZIP extraction, build/dependency installation, file browsing, log streaming, disk quotas, backups, or production egress filtering. Runtime command and environment validation still require a production review. Do not accept untrusted customer workloads until full isolation and abuse controls are implemented and tested.
