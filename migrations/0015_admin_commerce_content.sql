CREATE TABLE IF NOT EXISTS announcements (
 id TEXT PRIMARY KEY,
 title TEXT NOT NULL,
 description TEXT NOT NULL DEFAULT '',
 image_url TEXT,
 button_text TEXT,
 button_url TEXT,
 button_enabled INTEGER NOT NULL DEFAULT 0,
 enabled INTEGER NOT NULL DEFAULT 1,
 starts_at TEXT,
 ends_at TEXT,
 created_by INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS campaigns (
 id TEXT PRIMARY KEY,
 title TEXT NOT NULL,
 description TEXT NOT NULL DEFAULT '',
 audience TEXT NOT NULL DEFAULT 'all',
 payload_json TEXT NOT NULL DEFAULT '{}',
 status TEXT NOT NULL DEFAULT 'draft',
 scheduled_at TEXT,
 sent_at TEXT,
 created_by INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS coupons (
 id TEXT PRIMARY KEY,
 code TEXT NOT NULL UNIQUE COLLATE NOCASE,
 discount_type TEXT NOT NULL CHECK(discount_type IN ('percent','fixed')),
 discount_value INTEGER NOT NULL,
 currency TEXT NOT NULL DEFAULT 'USD',
 max_redemptions INTEGER,
 redemption_count INTEGER NOT NULL DEFAULT 0,
 starts_at TEXT,
 expires_at TEXT,
 enabled INTEGER NOT NULL DEFAULT 1,
 created_by INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_announcements_live ON announcements(enabled,starts_at,ends_at);
CREATE INDEX IF NOT EXISTS idx_campaigns_status ON campaigns(status,scheduled_at);
CREATE INDEX IF NOT EXISTS idx_coupons_code ON coupons(code,enabled);
