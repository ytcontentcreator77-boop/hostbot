-- Durable, provider-neutral task queue for VPS agents.
CREATE TABLE IF NOT EXISTS agent_tasks (
  id TEXT PRIMARY KEY,
  server_id INTEGER NOT NULL REFERENCES vps_servers(id),
  project_id TEXT REFERENCES projects(id),
  action TEXT NOT NULL CHECK(action IN ('create','start','stop','restart','delete')),
  payload_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','leased','succeeded','failed','cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_expires_at TEXT,
  result_json TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_poll ON agent_tasks(server_id,status,created_at);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_project ON agent_tasks(project_id,created_at);
