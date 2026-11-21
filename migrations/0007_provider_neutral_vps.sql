-- Provider-neutral VPS inventory. Any Linux VPS provider can join by running the HostPilot agent.
ALTER TABLE vps_servers ADD COLUMN provider TEXT NOT NULL DEFAULT 'custom';
ALTER TABLE vps_servers ADD COLUMN region TEXT;
ALTER TABLE vps_servers ADD COLUMN agent_version TEXT;
ALTER TABLE vps_servers ADD COLUMN last_heartbeat_at TEXT;
ALTER TABLE vps_servers ADD COLUMN agent_token_hash TEXT;
ALTER TABLE vps_servers ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE vps_servers ADD COLUMN last_error TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_vps_agent_token_hash ON vps_servers(agent_token_hash) WHERE agent_token_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_vps_status_enabled ON vps_servers(status,enabled);
