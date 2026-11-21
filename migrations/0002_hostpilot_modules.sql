-- HostPilot expansion: project lifecycle, payments, localization and retained engagement tools.
ALTER TABLE users ADD COLUMN can_message INTEGER NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN last_seen_at TEXT;
ALTER TABLE plans ADD COLUMN description TEXT NOT NULL DEFAULT '';
ALTER TABLE plans ADD COLUMN badge TEXT NOT NULL DEFAULT '';
ALTER TABLE plans ADD COLUMN max_dependency_bytes INTEGER NOT NULL DEFAULT 52428800;
ALTER TABLE plans ADD COLUMN allowed_runtimes TEXT NOT NULL DEFAULT '["python","nodejs"]';
ALTER TABLE plans ADD COLUMN allowed_versions TEXT NOT NULL DEFAULT '{}';
ALTER TABLE plans ADD COLUMN network_mbps INTEGER NOT NULL DEFAULT 10;
ALTER TABLE plans ADD COLUMN auto_renew INTEGER NOT NULL DEFAULT 0;
ALTER TABLE plans ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;
ALTER TABLE projects ADD COLUMN startup_command TEXT;
ALTER TABLE projects ADD COLUMN entry_file TEXT;
ALTER TABLE projects ADD COLUMN resource_limits_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE projects ADD COLUMN deleted_at TEXT;
CREATE TABLE IF NOT EXISTS project_files (
 id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL REFERENCES projects(id), relative_path TEXT NOT NULL,
 size_bytes INTEGER NOT NULL DEFAULT 0, checksum TEXT, storage_node_path TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(project_id, relative_path)
);
CREATE TABLE IF NOT EXISTS deployments (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), status TEXT NOT NULL,
 version INTEGER NOT NULL, commit_message TEXT, exit_code INTEGER, log_excerpt TEXT, started_at TEXT, finished_at TEXT,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS runtime_instances (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), server_id INTEGER NOT NULL REFERENCES vps_servers(id),
 container_ref TEXT NOT NULL, status TEXT NOT NULL, cpu_millicores INTEGER NOT NULL DEFAULT 0, ram_mb INTEGER NOT NULL DEFAULT 0,
 started_at TEXT, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS project_env (
 id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL REFERENCES projects(id), name TEXT NOT NULL,
 encrypted_value TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(project_id,name)
);
CREATE TABLE IF NOT EXISTS backups (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), server_id INTEGER REFERENCES vps_servers(id),
 storage_path TEXT NOT NULL, size_bytes INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'queued',
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, expires_at TEXT
);
CREATE TABLE IF NOT EXISTS vps_health_logs (
 id INTEGER PRIMARY KEY AUTOINCREMENT, server_id INTEGER NOT NULL REFERENCES vps_servers(id), cpu_percent REAL,
 ram_used_mb INTEGER, disk_used_mb INTEGER, network_rx_bytes INTEGER, network_tx_bytes INTEGER, healthy INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS payment_methods (
 id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, kind TEXT NOT NULL, instructions TEXT NOT NULL DEFAULT '',
 config_encrypted TEXT, min_amount_minor INTEGER NOT NULL DEFAULT 0, max_amount_minor INTEGER,
 enabled INTEGER NOT NULL DEFAULT 1, sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS payment_requests (
 id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), method_id INTEGER NOT NULL REFERENCES payment_methods(id),
 amount_minor INTEGER NOT NULL, currency TEXT NOT NULL, reference TEXT, proof_path TEXT, status TEXT NOT NULL DEFAULT 'pending',
 reviewed_by INTEGER, review_note TEXT, idempotency_key TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 reviewed_at TEXT
);
CREATE TABLE IF NOT EXISTS languages (code TEXT PRIMARY KEY, native_name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, is_default INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS translations (language_code TEXT NOT NULL REFERENCES languages(code), translation_key TEXT NOT NULL, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(language_code,translation_key));
CREATE TABLE IF NOT EXISTS bot_messages (message_key TEXT PRIMARY KEY, language_code TEXT NOT NULL DEFAULT 'en', text TEXT NOT NULL, media_path TEXT, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS announcements (
 id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', image_path TEXT, button_text TEXT, button_url TEXT,
 enabled INTEGER NOT NULL DEFAULT 1, starts_at TEXT, ends_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS campaigns (
 id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL,
 reward_minor INTEGER NOT NULL DEFAULT 0, currency TEXT NOT NULL DEFAULT 'USD', config_json TEXT NOT NULL DEFAULT '{}',
 enabled INTEGER NOT NULL DEFAULT 1, starts_at TEXT, ends_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS campaign_completions (
 id INTEGER PRIMARY KEY AUTOINCREMENT, campaign_id INTEGER NOT NULL REFERENCES campaigns(id), user_id INTEGER NOT NULL REFERENCES users(id),
 status TEXT NOT NULL DEFAULT 'pending', proof_path TEXT, rewarded_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(campaign_id,user_id)
);
CREATE TABLE IF NOT EXISTS bonus_rules (
 id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, amount_minor INTEGER NOT NULL, currency TEXT NOT NULL DEFAULT 'USD',
 config_json TEXT NOT NULL DEFAULT '{}', enabled INTEGER NOT NULL DEFAULT 1, starts_at TEXT, ends_at TEXT
);
CREATE TABLE IF NOT EXISTS coupons (
 id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, value_minor INTEGER NOT NULL,
 currency TEXT NOT NULL DEFAULT 'USD', max_redemptions INTEGER, per_user_limit INTEGER NOT NULL DEFAULT 1,
 redeemed_count INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1, expires_at TEXT
);
CREATE TABLE IF NOT EXISTS coupon_redemptions (
 id INTEGER PRIMARY KEY AUTOINCREMENT, coupon_id INTEGER NOT NULL REFERENCES coupons(id), user_id INTEGER NOT NULL REFERENCES users(id),
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(coupon_id,user_id)
);
CREATE TABLE IF NOT EXISTS support_tickets (
 id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), subject TEXT NOT NULL, category TEXT NOT NULL DEFAULT 'general',
 status TEXT NOT NULL DEFAULT 'open', priority TEXT NOT NULL DEFAULT 'normal', assigned_to INTEGER, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS ticket_messages (
 id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id TEXT NOT NULL REFERENCES support_tickets(id), sender_id INTEGER NOT NULL,
 is_staff INTEGER NOT NULL DEFAULT 0, is_internal INTEGER NOT NULL DEFAULT 0, body TEXT NOT NULL, attachment_path TEXT,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS broadcasts (
 id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, payload_json TEXT NOT NULL, audience_json TEXT NOT NULL DEFAULT '{}',
 status TEXT NOT NULL DEFAULT 'draft', scheduled_at TEXT, sent_count INTEGER NOT NULL DEFAULT 0, failed_count INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS broadcast_recipients (
 id INTEGER PRIMARY KEY AUTOINCREMENT, broadcast_id INTEGER NOT NULL REFERENCES broadcasts(id), user_id INTEGER NOT NULL REFERENCES users(id),
 status TEXT NOT NULL DEFAULT 'queued', error TEXT, sent_at TEXT, UNIQUE(broadcast_id,user_id)
);
CREATE TABLE IF NOT EXISTS referrals (
 id INTEGER PRIMARY KEY AUTOINCREMENT, referrer_id INTEGER NOT NULL REFERENCES users(id), referred_id INTEGER NOT NULL REFERENCES users(id),
 status TEXT NOT NULL DEFAULT 'pending', qualified_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(referred_id)
);
CREATE TABLE IF NOT EXISTS referral_rewards (
 id INTEGER PRIMARY KEY AUTOINCREMENT, referral_id INTEGER NOT NULL REFERENCES referrals(id), amount_minor INTEGER NOT NULL,
 currency TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', idempotency_key TEXT NOT NULL UNIQUE, rewarded_at TEXT
);
CREATE TABLE IF NOT EXISTS staff_roles (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, permissions_json TEXT NOT NULL DEFAULT '[]');
CREATE TABLE IF NOT EXISTS staff_permissions (telegram_id INTEGER NOT NULL, permission TEXT NOT NULL, allowed INTEGER NOT NULL DEFAULT 1, PRIMARY KEY(telegram_id,permission));
CREATE TABLE IF NOT EXISTS notifications (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id), kind TEXT NOT NULL, payload_json TEXT NOT NULL DEFAULT '{}', read_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS installation_state (id INTEGER PRIMARY KEY CHECK(id=1), is_locked INTEGER NOT NULL DEFAULT 0, completed_at TEXT);
CREATE TABLE IF NOT EXISTS audit_logs_v2 (id INTEGER PRIMARY KEY AUTOINCREMENT, staff_id INTEGER NOT NULL, action TEXT NOT NULL, target_type TEXT, target_id TEXT, metadata_json TEXT NOT NULL DEFAULT '{}', result TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX IF NOT EXISTS idx_payment_requests_status ON payment_requests(status,created_at);
CREATE INDEX IF NOT EXISTS idx_campaign_completion_user ON campaign_completions(user_id,status);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id,read_at);
CREATE INDEX IF NOT EXISTS idx_ticket_user ON support_tickets(user_id,status);
CREATE INDEX IF NOT EXISTS idx_broadcast_queue ON broadcast_recipients(broadcast_id,status);
CREATE TRIGGER IF NOT EXISTS wallet_tx_no_update BEFORE UPDATE ON wallet_transactions BEGIN SELECT RAISE(ABORT,'wallet ledger is immutable'); END;
CREATE TRIGGER IF NOT EXISTS wallet_tx_no_delete BEFORE DELETE ON wallet_transactions BEGIN SELECT RAISE(ABORT,'wallet ledger is immutable'); END;
INSERT OR IGNORE INTO languages(code,native_name,enabled,is_default) VALUES
('en','English',1,1),('hi','हिन्दी',1,0),('ne','नेपाली',1,0),('bn','বাংলা',1,0),('ur','اردو',1,0),
('es','Español',1,0),('pt','Português',1,0),('ru','Русский',1,0),('ar','العربية',1,0),('id','Bahasa Indonesia',1,0),
('vi','Tiếng Việt',1,0),('tr','Türkçe',1,0),('fr','Français',1,0),('de','Deutsch',1,0),('it','Italiano',1,0),
('ja','日本語',1,0),('ko','한국어',1,0),('zh','简体中文',1,0),('ta','தமிழ்',1,0),('te','తెలుగు',1,0),
('mr','मराठी',1,0),('pa','ਪੰਜਾਬੀ',1,0),('gu','ગુજરાતી',1,0),('fa','فارسی',1,0),('uk','Українська',1,0),
('pl','Polski',1,0),('th','ไทย',1,0),('ms','Bahasa Melayu',1,0);
INSERT OR IGNORE INTO plans(name,slug,price_minor,currency,duration_days,max_projects,max_upload_bytes,max_files,cpu_millicores,ram_mb,storage_mb,description,badge,sort_order)
VALUES
('Free','free',0,'USD',30,1,1048576,4,250,256,512,'Starter hosting plan','FREE',0),
('Silver','silver',0,'USD',30,2,5242880,8,500,512,2048,'For small projects','SILVER',1),
('Platinum','platinum',0,'USD',30,5,10485760,15,1000,1024,5120,'For growing projects','PLATINUM',2),
('Gold','gold',0,'USD',30,10,20971520,20,2000,2048,10240,'For demanding workloads','GOLD',3);
