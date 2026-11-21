ALTER TABLE agent_tasks ADD COLUMN lease_token TEXT;
CREATE INDEX IF NOT EXISTS idx_agent_tasks_lease ON agent_tasks(lease_expires_at);
