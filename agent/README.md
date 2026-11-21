# HostPilot VPS Node Agent (experimental)

HostPilot is provider-neutral: register multiple VPS machines from different hosting companies in one control plane. The provider field is only a label; the agent does not require a provider API key or vendor-specific SDK.

Compatible examples include VPS instances from Hetzner, DigitalOcean, Vultr, Linode/Akamai, OVHcloud, AWS EC2, Google Compute Engine, Azure, Oracle Cloud, Contabo, Hostinger, or a self-managed KVM server, provided the machine meets the requirements below. These are compatibility examples, not tested vendor certifications.

This agent is an early isolated-container execution prototype. It is not production-ready and must not be exposed directly to the public internet.

## Design
- Supported host: Linux VPS with a supported CPU architecture for the selected Docker images (normally x86_64/amd64 or ARM64), Node.js 22+, and a working Docker Engine API. The agent reports OS, architecture, Docker availability/version, CPU, RAM and disk capacity to HostPilot.
- Ubuntu, Debian, and other Linux distributions can be used if they provide Node.js 22+, systemd (for the example service setup), and Docker Engine. Windows VPS and non-Linux hosts are not supported by this Docker-based agent.
- Bind to loopback only; put it behind a TLS reverse proxy with mutual TLS or a private WireGuard network.
- Set a high-entropy `HOSTPILOT_AGENT_SECRET`; Worker requests use HMAC-SHA256 over timestamp, nonce, method, URL path and SHA-256 body hash.
- Nonces are kept briefly to reject replayed requests.
- Use rootless Docker and a dedicated OS account. The agent's Docker socket is effectively privileged to that Docker daemon.
- Customer containers run as root only inside a rootless Docker user namespace (not host root), drop Linux capabilities, use no-new-privileges, read-only root filesystem, bounded memory/CPU/PIDs and capped Docker logs. Keep the agent account dedicated to HostPilot.
- Project directories are derived from UUIDs beneath `PROJECT_ROOT`; clients cannot supply host paths.
- Runtime images are allowlisted. No HTML/static-site hosting.

## Install
1. On each VPS, install Node.js 22+ and rootless Docker using the official instructions for that Linux distribution. Repeat on every machine you want to attach; the provider does not matter.
2. Create a dedicated project root: `sudo install -d -m 0770 -o hostpilot -g hostpilot /srv/hostpilot/projects`.
3. Copy `.env.example` values into a protected environment file; set `HOSTPILOT_AGENT_SECRET`, `CONTROL_PLANE_URL` and the one-time `NODE_TOKEN` generated when an administrator registers this VPS in HostPilot. Never commit either secret.
4. Run `npm install`, `npm run build`, then run the compiled server under systemd.
5. Expose it only over private networking / mTLS; do not open port 8788 publicly.

## Important limitations
The prototype supports multiple provider-neutral registrations through outbound authenticated heartbeats. Each VPS independently reports its Linux platform, architecture, CPU/RAM/disk capacity, Docker availability/version and supported runtime image list. A server is reported healthy only when it is Linux and its Docker daemon responds. The provider label is informational, not a vendor integration. It still supports start/stop/restart/delete/status only and does not yet implement Worker-to-agent job dispatch, ZIP extraction, build/dependency installation, file browsing, log streaming, disk quotas, backups, or production egress filtering. Runtime command and environment validation still require a production review. Do not accept untrusted customer workloads until full isolation and abuse controls are implemented and tested.
