-- Public-key-only SSH access to individual project containers.
ALTER TABLE vps_servers ADD COLUMN ssh_host TEXT;
ALTER TABLE vps_servers ADD COLUMN ssh_port INTEGER NOT NULL DEFAULT 2222 CHECK(ssh_port BETWEEN 1 AND 65535);
CREATE TABLE IF NOT EXISTS terminal_ssh_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key_type TEXT NOT NULL CHECK(key_type IN ('ssh-ed25519','ecdsa-sha2-nistp256')),
  key_blob TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revoked_at TEXT,
  UNIQUE(project_id,user_id)
);
CREATE INDEX IF NOT EXISTS idx_terminal_ssh_keys_active ON terminal_ssh_keys(project_id,revoked_at);
CREATE INDEX IF NOT EXISTS idx_terminal_ssh_keys_user ON terminal_ssh_keys(user_id,revoked_at);
