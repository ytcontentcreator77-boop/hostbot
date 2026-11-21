-- Terminal entitlement controls. Access is off by default and can be granted per plan or per user.
ALTER TABLE plans ADD COLUMN terminal_enabled INTEGER NOT NULL DEFAULT 0 CHECK(terminal_enabled IN (0,1));
ALTER TABLE users ADD COLUMN terminal_override INTEGER CHECK(terminal_override IN (0,1) OR terminal_override IS NULL);
-- Paid tiers start enabled; administrators can change any plan, including Free, in the admin API.
UPDATE plans SET terminal_enabled=1 WHERE slug IN ('silver','platinum','gold');
CREATE INDEX IF NOT EXISTS idx_users_terminal_override ON users(terminal_override);
