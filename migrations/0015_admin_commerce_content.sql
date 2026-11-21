-- Extend the existing HostPilot engagement tables without replacing their integer primary keys.
ALTER TABLE announcements ADD COLUMN description TEXT NOT NULL DEFAULT '';
ALTER TABLE announcements ADD COLUMN image_url TEXT;
ALTER TABLE announcements ADD COLUMN button_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE announcements ADD COLUMN created_by INTEGER NOT NULL DEFAULT 0;
UPDATE announcements SET description=body, image_url=COALESCE(image_url,image_path), button_enabled=CASE WHEN button_url IS NOT NULL AND button_url<>'' THEN 1 ELSE 0 END;

ALTER TABLE campaigns ADD COLUMN audience TEXT NOT NULL DEFAULT 'all';
ALTER TABLE campaigns ADD COLUMN payload_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE campaigns ADD COLUMN status TEXT NOT NULL DEFAULT 'draft';
ALTER TABLE campaigns ADD COLUMN scheduled_at TEXT;
ALTER TABLE campaigns ADD COLUMN sent_at TEXT;
ALTER TABLE campaigns ADD COLUMN created_by INTEGER NOT NULL DEFAULT 0;
ALTER TABLE campaigns ADD COLUMN updated_at TEXT NOT NULL DEFAULT '';

ALTER TABLE coupons ADD COLUMN discount_type TEXT NOT NULL DEFAULT 'percent';
ALTER TABLE coupons ADD COLUMN discount_value INTEGER NOT NULL DEFAULT 0;
ALTER TABLE coupons ADD COLUMN redemption_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE coupons ADD COLUMN starts_at TEXT;
ALTER TABLE coupons ADD COLUMN created_by INTEGER NOT NULL DEFAULT 0;
UPDATE coupons SET discount_type=CASE WHEN lower(kind)='percent' THEN 'percent' ELSE 'fixed' END,
 discount_value=value_minor, redemption_count=redeemed_count;

CREATE INDEX IF NOT EXISTS idx_announcements_live ON announcements(enabled,starts_at,ends_at);
CREATE INDEX IF NOT EXISTS idx_campaigns_status ON campaigns(status,scheduled_at);
CREATE INDEX IF NOT EXISTS idx_coupons_code ON coupons(code,enabled);
