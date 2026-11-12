ALTER TABLE users ADD COLUMN github_login TEXT;
CREATE INDEX sessions_expires_at ON sessions (expires_at);
