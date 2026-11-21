CREATE TABLE IF NOT EXISTS project_uploads (
 id TEXT PRIMARY KEY,
 project_id TEXT NOT NULL REFERENCES projects(id),
 user_id INTEGER NOT NULL REFERENCES users(id),
 filename TEXT NOT NULL,
 size_bytes INTEGER NOT NULL,
 chunk_count INTEGER NOT NULL,
 status TEXT NOT NULL DEFAULT 'queued',
 detected_json TEXT NOT NULL DEFAULT '{}',
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS project_upload_chunks (
 upload_id TEXT NOT NULL REFERENCES project_uploads(id) ON DELETE CASCADE,
 chunk_index INTEGER NOT NULL,
 chunk_data BLOB NOT NULL,
 PRIMARY KEY(upload_id,chunk_index)
);
CREATE INDEX IF NOT EXISTS idx_project_uploads_project ON project_uploads(project_id,created_at);
