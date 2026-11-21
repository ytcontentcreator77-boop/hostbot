-- Per-file upload size is separate from ZIP deployment size.
ALTER TABLE plans ADD COLUMN max_file_bytes INTEGER NOT NULL DEFAULT 10485760;
UPDATE plans SET max_file_bytes=10485760 WHERE slug='free';
UPDATE plans SET max_file_bytes=52428800 WHERE slug='silver';
UPDATE plans SET max_file_bytes=104857600 WHERE slug='platinum';
UPDATE plans SET max_file_bytes=524288000 WHERE slug='gold';
